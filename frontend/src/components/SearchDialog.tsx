import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { Message } from 'primereact/message';
import { ProgressSpinner } from 'primereact/progressspinner';
import { useEffect, useState } from 'react';

import { formatAuthors, formatYear, hitKey } from '../format';
import { api } from '../services/api';
import { BookCover, LangPicker, SearchInput, type LangOption } from '../ui';
import type { BookInput, VolumeSearchResult } from '../types';

interface Props {
  visible: boolean;
  onHide: () => void;
  onAdd: (volume: VolumeSearchResult) => Promise<void>;
  existingVolumeIds: Set<string>;
  /** Open the manual form, optionally prefilled (from the query or a hit). */
  onAddManually?: (prefill: Partial<BookInput>) => void;
  /** Text to seed the search box with when the dialog opens (agent `open_add_book`). */
  initialQuery?: string;
}

/** `code` is what the small picker shows; `label` names it in the open list. */
const LANG_OPTIONS: readonly LangOption[] = [
  { value: '', code: 'ALL', label: 'Any language' },
  { value: 'pl', code: 'PL', label: 'Polski' },
  { value: 'en', code: 'EN', label: 'English' },
  { value: 'de', code: 'DE', label: 'Deutsch' },
  { value: 'fr', code: 'FR', label: 'Français' },
  { value: 'es', code: 'ES', label: 'Español' },
];

export function SearchDialog({
  visible,
  onHide,
  onAdd,
  existingVolumeIds,
  onAddManually,
  initialQuery,
}: Props) {
  const [query, setQuery] = useState('');
  const [lang, setLang] = useState('pl');
  const [results, setResults] = useState<VolumeSearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  // Seed the search box when opened via the agent with a query typed in.
  useEffect(() => {
    if (visible && initialQuery != null) {
      setQuery(initialQuery);
    }
  }, [visible, initialQuery]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  const runSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    setSearched(true);
    try {
      const resp = await api.search(query.trim(), lang || undefined);
      setResults(resp.items);
      setNotice(resp.notice ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const add = async (hit: VolumeSearchResult) => {
    setAdding(hit.google_volume_id ?? hit.title);
    try {
      await onAdd(hit);
    } finally {
      setAdding(null);
    }
  };

  const prefillFromHit = (hit: VolumeSearchResult): Partial<BookInput> => ({
    google_volume_id: hit.google_volume_id,
    title: hit.title,
    subtitle: hit.subtitle,
    authors: hit.authors,
    publisher: hit.publisher,
    published_date: hit.published_date,
    description: hit.description,
    page_count: hit.page_count,
    categories: hit.categories,
    language: hit.language,
    isbn_10: hit.isbn_10,
    isbn_13: hit.isbn_13,
    cover_url: hit.cover_url,
  });

  const addManually = (prefill: Partial<BookInput>) => {
    onAddManually?.(prefill);
    onHide();
  };

  return (
    <Dialog
      header="Add a book from Google Books"
      visible={visible}
      onHide={onHide}
      style={{ width: 'min(720px, 94vw)' }}
      dismissableMask
    >
      <div className="search-dialog-bar">
        {/* One field: the text input plus a small square language picker on its right. */}
        <div className="search-dialog-field">
          <div
            className="search-dialog-input"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
            }}
          >
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Title, author, or isbn:9780441013593"
              ariaLabel="Search Google Books"
            />
          </div>
          <LangPicker
            value={lang}
            options={LANG_OPTIONS}
            onChange={setLang}
            ariaLabel="Language filter"
            className="search-dialog-lang"
          />
        </div>
        <Button
          label="Search"
          icon="pi pi-search"
          onClick={() => void runSearch()}
          loading={loading}
          className="search-dialog-submit"
        />
      </div>

      {error && (
        <Message severity="error" text={error} className="search-dialog-message" />
      )}
      {!error && notice && (
        <Message severity="warn" text={notice} className="search-dialog-message" />
      )}

      {loading && (
        <div className="flex justify-content-center p-4">
          <ProgressSpinner style={{ width: '40px', height: '40px' }} />
        </div>
      )}

      {!loading && searched && results.length === 0 && !error && (
        <div className="empty-state">
          <p>No matches.</p>
          {lang ? (
            <p>
              Try “Any language” — this title may not have a {LANG_OPTIONS.find((o) => o.value === lang)?.label}{' '}
              edition in the current source.
            </p>
          ) : (
            <p>Try the original-language title or the author’s name.</p>
          )}
          {onAddManually && (
            <Button
              label="Can't find it? Add it manually"
              icon="pi pi-pencil"
              onClick={() => addManually({ title: query.trim() })}
            />
          )}
        </div>
      )}

      <div className="search-results">
        {results.map((hit, i) => {
          const already = hit.google_volume_id != null && existingVolumeIds.has(hit.google_volume_id);
          return (
            <div className="search-hit" key={hitKey(hit, i)}>
              <BookCover src={hit.cover_url} title="" size="hit" />
              <div className="hit-meta">
                <div className="t">{hit.title}</div>
                <div className="a">
                  {formatAuthors(hit.authors)}
                  {formatYear(hit.published_date) && ` · ${formatYear(hit.published_date)}`}
                </div>
              </div>
              <div className="hit-actions flex gap-2">
                {onAddManually && (
                  <Button
                    label="Edit & add"
                    title="Edit before adding"
                    icon="pi pi-pencil"
                    outlined
                    onClick={() => addManually(prefillFromHit(hit))}
                  />
                )}
                <Button
                  label={already ? 'In library' : 'Add'}
                  icon={already ? 'pi pi-check' : 'pi pi-plus'}
                  disabled={already}
                  loading={adding === (hit.google_volume_id ?? hit.title)}
                  onClick={() => void add(hit)}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer link only when the empty state (which has its own button) is not shown. */}
      {onAddManually && (results.length > 0 || (searched && !!error)) && (
        <div className="flex justify-content-center mt-3">
          <Button
            label="Can't find it? Add manually"
            icon="pi pi-pencil"
            text
            onClick={() => addManually({ title: query.trim() })}
          />
        </div>
      )}
    </Dialog>
  );
}
