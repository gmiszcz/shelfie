import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { useMemo, useRef, useState } from 'react';

import { BookDetailDialog } from '../components/BookDetailDialog';
import { SeriesCard } from '../components/SeriesCard';
import { SeriesEditDialog } from '../components/SeriesEditDialog';
import { useLibrary } from '../hooks/useLibrary';
import { useSeries } from '../hooks/useSeries';
import { api } from '../services/api';
import { useAgentAnchor } from '../agent-ui';
import { SearchInput } from '../ui';
import type { Book, ReadingStatus, SeriesSummary } from '../types';

import './Series.css';

const SECTIONS: { id: SeriesSummary['section']; label: string; icon: string; hint: string }[] = [
  { id: 'in_progress', label: 'In progress', icon: 'pi pi-book',
    hint: 'Started, not finished — with unread or missing volumes.' },
  { id: 'owned', label: 'Watched & other', icon: 'pi pi-bell',
    hint: 'Watched series and series you own but have not started.' },
  { id: 'complete', label: 'Complete', icon: 'pi pi-check-circle',
    hint: 'Every known volume read.' },
];

function matches(series: SeriesSummary, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const hay = [series.name, series.author, ...series.aliases].join(' ').toLowerCase();
  return needle
    .toLowerCase()
    .split(/\s+/)
    .every((t) => hay.includes(t));
}

export function Series() {
  const { series, expected, alerts, loading, error, reload, setWatch, refresh, removeExpected } =
    useSeries();
  const { books } = useLibrary();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Book | null>(null);
  const [editing, setEditing] = useState<SeriesSummary | null>(null);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [alertsDismissed, setAlertsDismissed] = useState(false);
  const toast = useRef<Toast>(null);
  // Fields the UI agent stages on series.editDialog before calling its "save" action.
  const editDialogDraft = useRef<{
    display_name?: string;
    author?: string;
    aliases?: string[];
    total_volumes?: number;
    notes?: string;
  }>({});

  const notifyError = (message: string) =>
    toast.current?.show({ severity: 'error', summary: 'Error', detail: message });

  const notifySuccess = (message: string) =>
    toast.current?.show({ severity: 'success', summary: 'Saved', detail: message, life: 2000 });

  const filtered = useMemo(
    () => series.filter((s) => matches(s, query.trim())),
    [series, query],
  );

  const bySectionInProgress = filtered.filter((s) => s.section === 'in_progress');
  const complete = filtered.filter((s) => s.section === 'complete');
  const middle = filtered.filter(
    (s) => s.section === 'owned' || (s.watch && s.section !== 'in_progress' && s.section !== 'complete'),
  );

  const grouped: Record<SeriesSummary['section'], SeriesSummary[]> = {
    in_progress: bySectionInProgress,
    owned: middle,
    complete,
  };

  const openVolume = async (bookId: number) => {
    try {
      setSelected(await api.getBook(bookId));
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not open book');
    }
  };

  const openEdit = (key: string) => {
    const hit = series.find((s) => s.series_key === key);
    if (hit) {
      setEditing(hit);
    }
  };

  // After any edit, reload the list and keep the open dialog pointed at the (possibly
  // renamed/merged) series so the user sees the result immediately.
  const handleEditSaved = async (message: string) => {
    notifySuccess(message);
    const openKey = editing?.series_key ?? null;
    const openName = editing?.name ?? null;
    await reload();
    const fresh = await api.listSeries();
    const next =
      fresh.find((s) => s.series_key === openKey) ||
      fresh.find((s) => s.name === openName) ||
      fresh.find((s) => (openName ? s.aliases.includes(openName) : false)) ||
      null;
    setEditing(next);
  };

  // --- UI-agent anchors (universal registry): the agent can search, watch, refresh and
  // manage the waiting list here without any agent-side code. -------------------------------
  const findSeries = (args?: Record<string, unknown>) => {
    const key = String(args?.key ?? args?.series ?? args?.name ?? '').trim().toLowerCase();
    const hit = series.find(
      (s) =>
        s.series_key.toLowerCase() === key ||
        s.display_name.toLowerCase() === key ||
        (s.aliases ?? []).some((a) => a.toLowerCase() === key) ||
        s.display_name.toLowerCase().includes(key),
    );
    if (!hit) {
      throw new Error(`no series "${key}"; see series.list for valid keys`);
    }
    return hit;
  };

  useAgentAnchor({
    id: 'series.search',
    kind: 'search',
    label: 'Series search',
    description: 'Filters the series list by series name, alias or author.',
    tab: 'series',
    getState: () => query,
    set: (v) => setQuery(typeof v === 'string' ? v : String(v ?? '')),
  });

  useAgentAnchor({
    id: 'series.list',
    kind: 'list',
    label: 'Series',
    description:
      'Series in the library with section (in_progress / owned / complete), watch flag and missing volumes. ' +
      'Actions: "watch" / "unwatch" with args { key }, "refresh" with { key } (runs the release lookup), ' +
      '"edit" with { key } (opens the series edit dialog — see series.editDialog), ' +
      '"open" with { book_id } to open an owned volume.',
    tab: 'series',
    actions: ['watch', 'unwatch', 'refresh', 'edit', 'open'],
    getState: () =>
      filtered.map((s) => ({
        key: s.series_key,
        name: s.display_name,
        section: s.section,
        watch: s.watch,
        missing: s.missing_volumes.map((m) => m.number),
      })),
    items: () => filtered.map((s) => ({ id: s.series_key, title: s.display_name })),
    invoke: async (action, args) => {
      if (action === 'open') {
        await openVolume(Number(args?.book_id));
        return;
      }
      const hit = findSeries(args);
      if (action === 'watch' || action === 'unwatch') {
        await setWatch(hit.series_key, action === 'watch');
      } else if (action === 'refresh') {
        await handleRefresh(hit.series_key);
      } else if (action === 'edit') {
        setEditing(hit);
      } else {
        throw new Error(`unknown action "${action}"; use watch, unwatch, refresh, edit or open`);
      }
    },
  });

  useAgentAnchor({
    id: 'series.editDialog',
    kind: 'dialog',
    label: 'Series edit dialog',
    description:
      'Edit one series. First invoke "open" with { key } (the series key/name) to open it — this ' +
      'anchor then edits THAT series. Stage field values with set (JSON object with any of ' +
      'display_name, author, aliases (array), total_volumes (number), notes), then invoke "save" to ' +
      'apply them (renames across all member books when display_name changes). Other actions: ' +
      '"add_book" { book_id, volume? }, "remove_book" { book_id }, "set_volume" { book_id, volume }, ' +
      '"rename" { name }, "merge" { other_key }, "cancel" to close.',
    tab: 'series',
    actions: ['open', 'save', 'cancel', 'add_book', 'remove_book', 'set_volume', 'rename', 'merge'],
    getState: () =>
      editing
        ? {
            open: true,
            key: editing.series_key,
            name: editing.name,
            author: editing.author,
            aliases: editing.aliases,
            total_volumes: editing.total_known,
            notes: editing.notes,
            books: editing.owned_volumes.map((o) => ({
              book_id: o.book_id,
              title: o.title,
              volume: o.volume_label ?? o.volume,
            })),
          }
        : { open: false },
    set: (value) => {
      if (value && typeof value === 'object') {
        editDialogDraft.current = { ...editDialogDraft.current, ...(value as Record<string, unknown>) };
      }
    },
    invoke: async (action, args) => {
      if (action === 'open') {
        const key = String(args?.key ?? args?.series ?? args?.name ?? '').trim().toLowerCase();
        const hit = series.find(
          (s) =>
            s.series_key.toLowerCase() === key ||
            s.name.toLowerCase() === key ||
            s.aliases.some((a) => a.toLowerCase() === key) ||
            s.name.toLowerCase().includes(key),
        );
        if (!hit) {
          throw new Error(`no series "${key}"; see series.list for valid keys`);
        }
        editDialogDraft.current = {};
        setEditing(hit);
        return;
      }
      if (!editing) {
        throw new Error('no series open; invoke "open" with { key } first');
      }
      const key = editing.series_key;
      if (action === 'cancel') {
        editDialogDraft.current = {};
        setEditing(null);
        return;
      }
      if (action === 'save') {
        const d = editDialogDraft.current;
        if (d.display_name && d.display_name.trim() && d.display_name.trim() !== editing.name) {
          await api.renameSeries(key, d.display_name.trim());
        }
        await api.updateSeries(d.display_name?.trim() || key, {
          aliases: d.aliases,
          author: d.author,
          total_volumes: d.total_volumes,
          notes: d.notes,
        });
        editDialogDraft.current = {};
        await handleEditSaved('Series saved');
        return;
      }
      if (action === 'add_book') {
        await api.addSeriesBook(key, Number(args?.book_id), (args?.volume as string) ?? null);
      } else if (action === 'remove_book') {
        await api.removeSeriesBook(key, Number(args?.book_id));
      } else if (action === 'set_volume') {
        await api.setSeriesBookVolume(key, Number(args?.book_id), (args?.volume as string) ?? null);
      } else if (action === 'rename') {
        await api.renameSeries(key, String(args?.name ?? ''));
      } else if (action === 'merge') {
        await api.mergeSeries(key, String(args?.other_key ?? args?.key ?? ''));
      } else {
        throw new Error(`unknown action "${action}"`);
      }
      await handleEditSaved('Series updated');
    },
  });

  useAgentAnchor({
    id: 'series.waitingList',
    kind: 'list',
    label: 'Waiting list',
    description: 'Upcoming / expected books. Action "remove" with args { id } removes one.',
    tab: 'series',
    actions: ['remove'],
    getState: () => expected.map((e) => ({ id: e.id, title: e.title, expected: e.expected_date ?? null })),
    items: () => expected.map((e) => ({ id: e.id, title: e.title })),
    invoke: async (action, args) => {
      if (action !== 'remove') {
        throw new Error('only "remove" is supported');
      }
      await removeExpected(Number(args?.id));
    },
  });

  const handleRefresh = async (key: string) => {
    setRefreshingKey(key);
    try {
      await refresh(key);
      toast.current?.show({ severity: 'success', summary: 'Refreshed', life: 2000 });
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Lookup failed');
    } finally {
      setRefreshingKey(null);
    }
  };

  const handleFavourite = async (id: number, next: boolean) => {
    try {
      await api.updateBook(id, { favourite: next });
      setSelected((prev) => (prev && prev.id === id ? { ...prev, favourite: next } : prev));
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not update favourite');
    }
  };

  const handleStatus = async (id: number, status: ReadingStatus) => {
    try {
      await api.updateBook(id, { status });
      setSelected((prev) => (prev && prev.id === id ? { ...prev, status } : prev));
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not update status');
    }
  };

  const handleStars = async (id: number, stars: number | null) => {
    try {
      await api.updateBook(id, { stars });
      setSelected((prev) => (prev && prev.id === id ? { ...prev, stars } : prev));
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not update rating');
    }
  };

  const alertCount = alerts?.count ?? 0;
  const showAlerts = !alertsDismissed && alertCount > 0;

  return (
    <>
      <Toast ref={toast} position="bottom-right" />

      <div className="series-toolbar">
        <div className="series-toolbar-head">
          <h2 className="series-title">
            <i className="pi pi-bookmark" aria-hidden="true" /> Series
            {alertCount > 0 && <span className="series-badge">{alertCount}</span>}
          </h2>
          <span className="series-count">
            {loading ? 'Loading…' : `${filtered.length} of ${series.length} series`}
          </span>
        </div>

        <div className="series-toolbar-search">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Filter series by name, author or alias…"
            ariaLabel="Filter series"
          />
        </div>
      </div>

      {showAlerts && (
        <section className="series-alerts" aria-label="Series notifications">
          <div className="series-alerts-head">
            <strong>
              <i className="pi pi-bell" aria-hidden="true" /> {alertCount} notification
              {alertCount === 1 ? '' : 's'}
            </strong>
            <Button
              icon="pi pi-times"
              rounded
              text
              aria-label="Dismiss notifications"
              onClick={() => setAlertsDismissed(true)}
            />
          </div>
          <ul className="series-alerts-list">
            {alerts?.new_volume.map((a) => (
              <li key={`nv-${a.series_key}`}>
                <i className="pi pi-sparkles" aria-hidden="true" /> {a.message}
                {a.detail && <span className="series-alert-detail"> · {a.detail}</span>}
              </li>
            ))}
            {alerts?.in_progress.map((a) => (
              <li key={`ip-${a.series_key}`}>
                <i className="pi pi-book" aria-hidden="true" /> {a.message}
                {a.detail && <span className="series-alert-detail"> · {a.detail}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p style={{ color: 'var(--red-400)' }}>{error}</p>}

      {!loading && series.length === 0 && (
        <div className="empty-state">
          <i className="pi pi-bookmark" style={{ fontSize: '2.5rem' }} />
          <p>No series yet. Series are detected from the books in your library.</p>
        </div>
      )}

      {SECTIONS.map((section) => {
        const items = grouped[section.id];
        if (items.length === 0) {
          return null;
        }
        return (
          <section key={section.id} className="series-section">
            <div className="series-section-head">
              <h3>
                <i className={section.icon} aria-hidden="true" /> {section.label}
                <span className="series-section-count">{items.length}</span>
              </h3>
              <p className="series-section-hint">{section.hint}</p>
            </div>
            <div className="series-grid">
              {items.map((s) => (
                <SeriesCard
                  key={s.series_key}
                  series={s}
                  onOpenVolume={openVolume}
                  onToggleWatch={(key, watch) =>
                    setWatch(key, watch).catch((err) =>
                      notifyError(err instanceof Error ? err.message : 'Could not toggle watch'),
                    )
                  }
                  onRefresh={handleRefresh}
                  onEdit={openEdit}
                  refreshing={refreshingKey === s.series_key}
                />
              ))}
            </div>
          </section>
        );
      })}

      {/* Waiting list: not-yet-owned upcoming books. */}
      <section className="series-section">
        <div className="series-section-head">
          <h3>
            <i className="pi pi-clock" aria-hidden="true" /> Waiting list
            <span className="series-section-count">{expected.length}</span>
          </h3>
          <p className="series-section-hint">
            Upcoming / not-yet-owned books from watched series and manual adds.
          </p>
        </div>
        {expected.length === 0 ? (
          <p className="series-waiting-empty">
            Nothing on the waiting list. Watch a series or ask the assistant to add an upcoming
            book.
          </p>
        ) : (
          <ul className="series-waiting-list">
            {expected.map((e) => (
              <li key={e.id} className="series-waiting-item">
                <div className="series-waiting-main">
                  <span className="series-waiting-title">{e.title}</span>
                  <span className="series-waiting-meta">
                    {e.author}
                    {e.series_name && ` · ${e.series_name}`}
                    {e.volume && ` · vol. ${e.volume}`}
                    {e.expected_date && ` · ${e.expected_date}`}
                  </span>
                </div>
                <div className="series-waiting-actions">
                  {e.source_url && (
                    <a href={e.source_url} target="_blank" rel="noreferrer noopener">
                      source
                    </a>
                  )}
                  <Button
                    icon="pi pi-trash"
                    rounded
                    text
                    severity="danger"
                    aria-label={`Remove ${e.title} from the waiting list`}
                    onClick={() =>
                      removeExpected(e.id).catch((err) =>
                        notifyError(err instanceof Error ? err.message : 'Could not remove'),
                      )
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <BookDetailDialog
        book={selected}
        onHide={() => setSelected(null)}
        onStatus={handleStatus}
        onStars={handleStars}
        onDelete={() => undefined}
        onEdit={() => undefined}
        onFavourite={handleFavourite}
      />

      <SeriesEditDialog
        series={editing}
        allSeries={series}
        books={books}
        onHide={() => setEditing(null)}
        onSaved={handleEditSaved}
        onError={notifyError}
      />
    </>
  );
}
