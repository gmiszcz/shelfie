import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { Dropdown } from 'primereact/dropdown';
import { InputText } from 'primereact/inputtext';
import { ProgressSpinner } from 'primereact/progressspinner';
import { useEffect, useState } from 'react';

import { formatAuthors, formatYear, hitKey } from '../format';
import { api } from '../services/api';
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

const LANG_OPTIONS = [
  { value: '', label: 'Any language' },
  { value: 'pl', label: 'Polski' },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
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
  const [lang, setLang] = useState('');
  const [results, setResults] = useState<VolumeSearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  // Seed the search box when opened via the agent with a query typed in.
  useEffect(() => {
    if (visible && initialQuery != null) {
      setQuery(initialQuery);
    }
  }, [visible, initialQuery]);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  const runSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const resp = await api.search(query.trim(), lang || undefined);
      setResults(resp.items);
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
      <div className="flex gap-2 mb-3">
        <span className="search-input-wrap" style={{ flex: 1 }}>
          <i className="pi pi-search" />
          <InputText
            value={query}
            placeholder="Title, author, or isbn:9780441013593"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
            }}
            style={{ width: '100%' }}
            autoFocus
          />
        </span>
        <Dropdown
          value={lang}
          options={LANG_OPTIONS}
          onChange={(e) => setLang(e.value)}
          aria-label="Language filter"
        />
        <Button label="Search" icon="pi pi-search" onClick={() => void runSearch()} loading={loading} />
      </div>

      {error && <p style={{ color: 'var(--red-400)' }}>{error}</p>}

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
              {hit.cover_url ? (
                <img src={hit.cover_url} alt="" loading="lazy" />
              ) : (
                <div className="no-cover flex align-items-center justify-content-center">
                  <i className="pi pi-book" />
                </div>
              )}
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
                    label="Edit before adding"
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

      {onAddManually && (searched || results.length > 0) && (
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
