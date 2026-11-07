import { Button } from 'primereact/button';
import { Chips } from 'primereact/chips';
import { Dialog } from 'primereact/dialog';
import { Dropdown } from 'primereact/dropdown';
import { InputNumber } from 'primereact/inputnumber';
import { InputText } from 'primereact/inputtext';
import { InputTextarea } from 'primereact/inputtextarea';
import { useEffect, useMemo, useState } from 'react';

import { api } from '../services/api';
import { SearchInput } from '../ui';
import type { Book, SeriesSummary } from '../types';

import './SeriesEditDialog.css';

interface Props {
  /** The series being edited, or null when the dialog is closed. */
  series: SeriesSummary | null;
  /** All series (for the "Merge with…" picker). */
  allSeries: SeriesSummary[];
  /** The whole library (for the "Add book" search). */
  books: Book[];
  onHide: () => void;
  /** Called after any successful change so the parent can reload the series list. */
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}

interface Draft {
  name: string;
  aliases: string[];
  author: string;
  total: number | null;
  notes: string;
}

function toDraft(s: SeriesSummary): Draft {
  return {
    name: s.name,
    aliases: [...s.aliases],
    author: s.author,
    total: s.total_known ?? null,
    notes: s.notes ?? '',
  };
}

/**
 * Edit one series: its display name, aliases, author, total volumes and notes; the
 * member books (editable volume + remove); add a library book to the series; merge
 * another series into this one; rename across every member book.
 *
 * All layout spacing comes from the :root tokens in index.css. On phones the dialog is
 * full-screen and single-column (see SeriesEditDialog.css).
 */
export function SeriesEditDialog({ series, allSeries, books, onHide, onSaved, onError }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [addVolume, setAddVolume] = useState('');
  const [addBookId, setAddBookId] = useState<number | null>(null);
  const [mergeKey, setMergeKey] = useState<string | null>(null);

  const visible = series !== null;

  useEffect(() => {
    if (series) {
      setDraft(toDraft(series));
      setAddQuery('');
      setAddVolume('');
      setAddBookId(null);
      setMergeKey(null);
    } else {
      setDraft(null);
    }
  }, [series]);

  const ownedIds = useMemo(
    () => new Set((series?.owned_volumes ?? []).map((o) => o.book_id)),
    [series],
  );

  const addCandidates = useMemo(() => {
    const needle = addQuery.trim().toLowerCase();
    if (!needle) {
      return [];
    }
    const terms = needle.split(/\s+/).filter(Boolean);
    return books
      .filter((b) => !ownedIds.has(b.id))
      .filter((b) => {
        const hay = [b.title, b.subtitle ?? '', b.series ?? '', ...b.authors]
          .join(' ')
          .toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .slice(0, 8);
  }, [addQuery, books, ownedIds]);

  const mergeOptions = useMemo(
    () =>
      allSeries
        .filter((s) => s.series_key !== series?.series_key)
        .map((s) => ({ label: s.name, value: s.series_key }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [allSeries, series],
  );

  if (!series || !draft) {
    return <Dialog visible={false} onHide={onHide} />;
  }

  const key = series.series_key;
  const set = <K extends keyof Draft>(field: K, value: Draft[K]) =>
    setDraft((prev) => (prev ? { ...prev, [field]: value } : prev));

  const guard = async (run: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await run();
      onSaved(ok);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const saveMeta = () =>
    guard(async () => {
      const nameChanged = draft.name.trim() && draft.name.trim() !== series.name;
      if (nameChanged) {
        // Renaming rewrites every member book; do it first so the key the metadata
        // PATCH targets still resolves (by its new name or kept-as-alias old name).
        await api.renameSeries(key, draft.name.trim());
      }
      await api.updateSeries(nameChanged ? draft.name.trim() : key, {
        aliases: draft.aliases,
        author: draft.author,
        total_volumes: draft.total ?? undefined,
        notes: draft.notes,
      });
    }, 'Series saved');

  const changeVolume = (bookId: number, volume: string) =>
    guard(async () => {
      await api.setSeriesBookVolume(key, bookId, volume.trim() || null);
    }, 'Volume updated');

  const removeBook = (bookId: number) =>
    guard(async () => {
      await api.removeSeriesBook(key, bookId);
    }, 'Book removed from series');

  const addBook = () =>
    guard(async () => {
      if (addBookId == null) {
        throw new Error('Pick a book to add');
      }
      await api.addSeriesBook(key, addBookId, addVolume.trim() || null);
      setAddQuery('');
      setAddVolume('');
      setAddBookId(null);
    }, 'Book added to series');

  const merge = () =>
    guard(async () => {
      if (!mergeKey) {
        throw new Error('Pick a series to merge');
      }
      await api.mergeSeries(key, mergeKey);
      setMergeKey(null);
    }, 'Series merged');

  const footer = (
    <div className="sed-footer">
      <Button label="Close" icon="pi pi-times" text onClick={onHide} disabled={busy} />
      <Button
        label="Save"
        icon="pi pi-check"
        onClick={() => void saveMeta()}
        loading={busy}
      />
    </div>
  );

  return (
    <Dialog
      header={`Edit series — ${series.name}`}
      visible={visible}
      onHide={onHide}
      footer={footer}
      className="sed-dialog"
      dismissableMask={!busy}
      closable={!busy}
    >
      <div className="sed-body">
        <section className="sed-section">
          <h4 className="sed-section-title">Details</h4>
          <div className="sed-grid">
            <label className="sed-field">
              <span>Name</span>
              <InputText value={draft.name} onChange={(e) => set('name', e.target.value)} />
              <small className="sed-hint">
                Changing the name rewrites it on every book in the series; the old name is
                kept as an alias.
              </small>
            </label>
            <label className="sed-field">
              <span>Author</span>
              <InputText value={draft.author} onChange={(e) => set('author', e.target.value)} />
            </label>
            <label className="sed-field">
              <span>Total volumes</span>
              <InputNumber
                value={draft.total}
                onValueChange={(e) => set('total', e.value ?? null)}
                min={0}
                useGrouping={false}
                showButtons
              />
            </label>
            <label className="sed-field sed-field-wide">
              <span>Aliases</span>
              <Chips
                value={draft.aliases}
                onChange={(e) => set('aliases', e.value ?? [])}
                separator=","
                placeholder="Add an alias and press Enter"
              />
            </label>
            <label className="sed-field sed-field-wide">
              <span>Notes</span>
              <InputTextarea
                value={draft.notes}
                onChange={(e) => set('notes', e.target.value)}
                rows={2}
                autoResize
              />
            </label>
          </div>
        </section>

        <section className="sed-section">
          <h4 className="sed-section-title">Books in this series</h4>
          {series.owned_volumes.length === 0 ? (
            <p className="sed-empty">No books in this series yet.</p>
          ) : (
            <ul className="sed-books">
              {series.owned_volumes.map((vol) => (
                <li key={vol.book_id} className="sed-book">
                  <span className="sed-book-title" title={vol.title}>
                    {vol.title}
                  </span>
                  <InputText
                    className="sed-book-vol"
                    defaultValue={vol.volume_label ?? (vol.volume != null ? String(vol.volume) : '')}
                    placeholder="vol."
                    aria-label={`Volume of ${vol.title}`}
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      const current = vol.volume_label ?? (vol.volume != null ? String(vol.volume) : '');
                      if (next !== current) {
                        void changeVolume(vol.book_id, next);
                      }
                    }}
                    disabled={busy}
                  />
                  <Button
                    icon="pi pi-times"
                    rounded
                    text
                    severity="danger"
                    aria-label={`Remove ${vol.title} from the series`}
                    disabled={busy}
                    onClick={() => void removeBook(vol.book_id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="sed-section">
          <h4 className="sed-section-title">Add a book</h4>
          <SearchInput
            value={addQuery}
            onChange={(v) => {
              setAddQuery(v);
              setAddBookId(null);
            }}
            placeholder="Search your library by title or author…"
            ariaLabel="Search the library to add a book to this series"
          />
          {addCandidates.length > 0 && (
            <ul className="sed-candidates">
              {addCandidates.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    className={`sed-candidate ${addBookId === b.id ? 'sed-candidate--on' : ''}`}
                    onClick={() => setAddBookId(b.id)}
                  >
                    <span className="sed-candidate-title">{b.title}</span>
                    <span className="sed-candidate-meta">
                      {b.authors.join(', ')}
                      {b.series && ` · ${b.series}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="sed-add-row">
            <InputText
              value={addVolume}
              onChange={(e) => setAddVolume(e.target.value)}
              placeholder="Volume (optional)"
              aria-label="Volume for the added book"
              className="sed-book-vol"
            />
            <Button
              label="Add to series"
              icon="pi pi-plus"
              onClick={() => void addBook()}
              disabled={busy || addBookId == null}
            />
          </div>
        </section>

        <section className="sed-section">
          <h4 className="sed-section-title">Merge with…</h4>
          <div className="sed-add-row">
            <Dropdown
              value={mergeKey}
              options={mergeOptions}
              onChange={(e) => setMergeKey(e.value)}
              placeholder="Pick a series to merge into this one"
              filter
              className="sed-merge-pick"
            />
            <Button
              label="Merge"
              icon="pi pi-sign-in"
              severity="warning"
              onClick={() => void merge()}
              disabled={busy || !mergeKey}
            />
          </div>
          <small className="sed-hint">
            The other series' books move into “{series.name}”; its names are kept as aliases.
          </small>
        </section>
      </div>
    </Dialog>
  );
}
