import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { useMemo, useRef, useState } from 'react';

import { BookDetailDialog } from '../components/BookDetailDialog';
import { SeriesCard } from '../components/SeriesCard';
import { SeriesAddBook } from '../components/SeriesAddBook';
import { SeriesEditDialog } from '../components/SeriesEditDialog';
import { useLibrary } from '../hooks/useLibrary';
import { useSeries } from '../hooks/useSeries';
import { api } from '../services/api';
import {
  filterCounts,
  matchesFilter,
  matchesQuery,
  orderWatching,
  orphanExpected,
} from '../seriesView';
import { useAgentAnchor } from '../agent-ui';
import { FilterBar, SearchInput } from '../ui';
import type {
  Book,
  ExpectedBook,
  ReadingStatus,
  SeriesFilterId,
  SeriesSearchLang,
  SeriesSummary,
} from '../types';

import './Series.css';

const FILTERS: { id: SeriesFilterId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'watching', label: 'Watching' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'missing', label: 'Missing volumes' },
  { id: 'complete', label: 'Complete' },
  { id: 'owned', label: 'Owned' },
];

// Sections rendered below the Watching section (depend on the active filter).
const SECTIONS: { id: SeriesSummary['section']; label: string; icon: string; hint: string }[] = [
  { id: 'in_progress', label: 'In progress', icon: 'pi pi-book',
    hint: 'Started, not finished — with unread or missing volumes.' },
  { id: 'owned', label: 'Owned & other', icon: 'pi pi-book',
    hint: 'Series you own but have not started.' },
  { id: 'complete', label: 'Complete', icon: 'pi pi-check-circle',
    hint: 'Every known volume read.' },
];

/** One waiting-list row (reused in the Watching section and the Waiting list section). */
function WaitingRow({
  item,
  onRemove,
}: {
  item: ExpectedBook;
  onRemove: (id: number) => void;
}) {
  // Researched entries carry their edition in the source ("series_research:pl").
  const edition = item.source?.startsWith('series_research:')
    ? item.source.split(':')[1]?.toUpperCase()
    : null;
  return (
    <li className="series-waiting-item">
      <div className="series-waiting-main">
        <span className="series-waiting-title" title={item.title}>
          {item.title}
        </span>
        <span className="series-waiting-facts">
          {edition && <span className="series-waiting-ed">{edition}</span>}
          <span className={`series-waiting-date${item.expected_date ? '' : ' none'}`}>
            <i className="pi pi-calendar" aria-hidden="true" />
            {item.expected_date ?? 'no date'}
          </span>
          {item.volume && <span className="series-waiting-meta">vol. {item.volume}</span>}
        </span>
        <span className="series-waiting-meta">
          {item.author}
          {item.series_name && ` · ${item.series_name}`}
        </span>
      </div>
      <div className="series-waiting-actions">
        {item.source_url && (
          <a
            className="series-waiting-src"
            href={item.source_url}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`Source for ${item.title}`}
            title="Source"
          >
            <i className="pi pi-external-link" aria-hidden="true" />
          </a>
        )}
        <Button
          icon="pi pi-trash"
          rounded
          text
          severity="danger"
          aria-label={`Remove ${item.title} from the waiting list`}
          onClick={() => onRemove(item.id)}
        />
      </div>
    </li>
  );
}

export function Series() {
  const {
    series,
    expected,
    alerts,
    filter,
    loading,
    error,
    reload,
    setWatch,
    refresh,
    setLang,
    addVolume,
    removeExpected,
    setFilter,
    dismissAlerts,
  } = useSeries();
  const { books, reload: reloadBooks } = useLibrary();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Book | null>(null);
  const [editing, setEditing] = useState<SeriesSummary | null>(null);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
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

  // Search first, then the active filter. Counts are over the search-filtered set so each
  // filter pill shows how many it would land on.
  const searched = useMemo(
    () => series.filter((s) => matchesQuery(s, query.trim())),
    [series, query],
  );
  const counts = useMemo(() => filterCounts(searched), [searched]);
  const filtered = useMemo(
    () => searched.filter((s) => matchesFilter(s, filter)),
    [searched, filter],
  );

  // Watching section: watched series (search-filtered) ordered by nearest known date.
  const watching = useMemo(() => orderWatching(searched), [searched]);
  const orphans = useMemo(() => orphanExpected(expected, series), [expected, series]);
  const expectedBySeries = useMemo(() => {
    const map = new Map<string, ExpectedBook[]>();
    for (const e of expected) {
      if (e.series_key) {
        const list = map.get(e.series_key) ?? [];
        list.push(e);
        map.set(e.series_key, list);
      }
    }
    return map;
  }, [expected]);

  // The lower sections honour the active filter: when a specific filter is chosen we only
  // show that bucket (as one flat grid); on "all" we keep the familiar section split.
  const bySectionInProgress = filtered.filter((s) => s.section === 'in_progress');
  const complete = filtered.filter((s) => s.section === 'complete');
  const middle = filtered.filter((s) => s.section === 'owned');
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

  const handleRefresh = async (key: string, searchLang?: SeriesSearchLang) => {
    setRefreshingKey(key);
    try {
      await refresh(key, searchLang);
      toast.current?.show({ severity: 'success', summary: 'Refreshed', life: 2000 });
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Lookup failed');
    } finally {
      setRefreshingKey(null);
    }
  };

  const handleAddVolume = async (key: string, title: string, volume: number | null) => {
    try {
      await addVolume(key, title, volume);
      toast.current?.show({
        severity: 'success',
        summary: 'Added to library',
        detail: `${title} · Want to read`,
        life: 2500,
      });
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not add the book');
    }
  };

  const handleSetLang = async (key: string, lang: SeriesSearchLang) => {
    try {
      await setLang(key, lang);
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not change language');
    }
  };

  // --- UI-agent anchors --------------------------------------------------------------------
  const findSeries = (args?: Record<string, unknown>) => {
    const key = String(args?.key ?? args?.series ?? args?.name ?? '').trim().toLowerCase();
    const hit = series.find(
      (s) =>
        s.series_key.toLowerCase() === key ||
        s.name.toLowerCase() === key ||
        (s.aliases ?? []).some((a) => a.toLowerCase() === key) ||
        s.name.toLowerCase().includes(key),
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
      'State also carries the active filter (one of all, watching, in_progress, missing, complete, owned). ' +
      'Actions: "watch" / "unwatch" with args { key }, "refresh" with { key } (runs the release lookup), ' +
      '"edit" with { key } (opens the series edit dialog — see series.editDialog), ' +
      '"open" with { book_id } to open an owned volume, ' +
      '"set_filter" with { filter } to change the active filter (persisted per user), ' +
      '"dismiss_alerts" with { keys?: [alert_key], all?: boolean } to mark notifications seen.',
    tab: 'series',
    actions: ['watch', 'unwatch', 'refresh', 'edit', 'open', 'set_filter', 'dismiss_alerts'],
    getState: () => ({
      filter,
      unseen_alerts: alerts?.unseen_count ?? 0,
      series: filtered.map((s) => ({
        key: s.series_key,
        name: s.name,
        section: s.section,
        watch: s.watch,
        missing: s.missing_volumes.map((m) => m.number),
      })),
    }),
    items: () => filtered.map((s) => ({ id: s.series_key, title: s.name })),
    invoke: async (action, args) => {
      if (action === 'open') {
        await openVolume(Number(args?.book_id));
        return;
      }
      if (action === 'set_filter') {
        const next = String(args?.filter ?? '').trim() as SeriesFilterId;
        if (!FILTERS.some((f) => f.id === next)) {
          throw new Error(
            `unknown filter "${next}"; use all, watching, in_progress, missing, complete or owned`,
          );
        }
        setFilter(next);
        return;
      }
      if (action === 'dismiss_alerts') {
        const keys = Array.isArray(args?.keys) ? (args?.keys as string[]) : undefined;
        const all = Boolean(args?.all) || !keys;
        await dismissAlerts(all ? { all: true } : { alert_keys: keys });
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
        throw new Error(`unknown action "${action}"`);
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

  const unseenCount = alerts?.unseen_count ?? 0;
  const allAlerts = alerts ? [...alerts.new_volume, ...alerts.in_progress] : [];
  const unseenAlerts = allAlerts.filter((a) => !a.seen);
  const showBanner = unseenCount > 0;

  const dismissAll = () =>
    dismissAlerts({ all: true }).catch((err) =>
      notifyError(err instanceof Error ? err.message : 'Could not dismiss notifications'),
    );

  // Show the Watching section whenever the filter is "all" or "watching" (and there is
  // something to show). A specific non-watching filter hides it to avoid duplicate cards.
  const showWatching =
    (filter === 'all' || filter === 'watching') && (watching.length > 0 || orphans.length > 0);
  const showLowerSections = filter !== 'watching';

  return (
    <>
      <Toast ref={toast} position="bottom-right" />

      <div className="series-toolbar">
        <div className="series-toolbar-head">
          <h2 className="series-title">
            <i className="pi pi-bookmark" aria-hidden="true" /> Series
            {unseenCount > 0 && (
              <span className="series-badge" aria-label={`${unseenCount} unseen notifications`}>
                {unseenCount}
              </span>
            )}
          </h2>
          <span className="series-count">
            {loading ? 'Loading…' : `${filtered.length} of ${series.length} series`}
          </span>
        </div>

        <div className="series-toolbar-search" data-agent-anchor="series.search">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Filter series by name, author or alias…"
            ariaLabel="Filter series"
          />
        </div>

        <FilterBar
          ariaLabel="Filter series"
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) => ({ id: f.id, label: f.label, count: counts[f.id] }))}
        />
      </div>

      {showBanner && (
        <section className="series-alerts" aria-label="Series notifications">
          <div className="series-alerts-head">
            <strong>
              <i className="pi pi-bell" aria-hidden="true" /> {unseenCount} new notification
              {unseenCount === 1 ? '' : 's'}
            </strong>
            <Button
              icon="pi pi-times"
              rounded
              text
              aria-label="Dismiss notifications"
              onClick={dismissAll}
            />
          </div>
          <ul className="series-alerts-list">
            {unseenAlerts.map((a) => (
              <li key={a.alert_key}>
                <i
                  className={a.kind === 'new_volume' ? 'pi pi-sparkles' : 'pi pi-book'}
                  aria-hidden="true"
                />{' '}
                {a.message}
                {a.detail && <span className="series-alert-detail"> · {a.detail}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}


      {error && <p style={{ color: 'var(--accent-red)' }}>{error}</p>}

      {!loading && series.length === 0 && (
        <div className="empty-state">
          <i className="pi pi-bookmark" style={{ fontSize: '2.5rem' }} />
          <p>No series yet. Series are detected from the books in your library.</p>
        </div>
      )}

      {/* Watching: watched series first, each with its next expected volume, plus the
          waiting-list items of that series; orphan waiting-list items follow. */}
      {showWatching && (
        <section className="series-section" aria-label="Watching">
          <div className="series-section-head">
            <h3>
              <i className="pi pi-bell" aria-hidden="true" /> Watching
              <span className="series-section-count">{watching.length}</span>
            </h3>
            <p className="series-section-hint">
              Series you watch for new volumes, nearest known release first.
            </p>
          </div>
          <div className="series-grid" data-agent-anchor="series.list">
            {watching.map((s) => {
              const waiting = expectedBySeries.get(s.series_key) ?? [];
              return (
                <div key={s.series_key} className="series-watch-group">
                  <SeriesCard
                    series={s}
                    onOpenVolume={openVolume}
                    onToggleWatch={(key, watch) =>
                      setWatch(key, watch).catch((err) =>
                        notifyError(err instanceof Error ? err.message : 'Could not toggle watch'),
                      )
                    }
                    onRefresh={handleRefresh}
                    onSetLang={handleSetLang}
              onAddVolume={handleAddVolume}
                    onEdit={openEdit}
                    refreshing={refreshingKey === s.series_key}
                  />
                  {waiting.length > 0 && (
                    <ul className="series-waiting-list series-watch-waiting">
                      {waiting.map((e) => (
                        <WaitingRow
                          key={e.id}
                          item={e}
                          onRemove={(id) =>
                            removeExpected(id).catch((err) =>
                              notifyError(err instanceof Error ? err.message : 'Could not remove'),
                            )
                          }
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
          {orphans.length > 0 && (
            <div className="series-watch-orphans">
              <p className="series-section-hint">Waiting-list items with no series</p>
              <ul className="series-waiting-list">
                {orphans.map((e) => (
                  <WaitingRow
                    key={e.id}
                    item={e}
                    onRemove={(id) =>
                      removeExpected(id).catch((err) =>
                        notifyError(err instanceof Error ? err.message : 'Could not remove'),
                      )
                    }
                  />
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {showLowerSections &&
        SECTIONS.map((section) => {
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
              <div className="series-grid" data-agent-anchor="series.list">
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
                    onSetLang={handleSetLang}
              onAddVolume={handleAddVolume}
                    onEdit={openEdit}
                    refreshing={refreshingKey === s.series_key}
                  />
                ))}
              </div>
            </section>
          );
        })}

      {/* A book with no series never shows above: put it in one (and watch it) here. */}
      <SeriesAddBook
        books={books}
        series={series}
        onWatch={(key) => setWatch(key, true)}
        onDone={(message) => {
          notifySuccess(message);
          void reload();
          void reloadBooks();
        }}
        onError={notifyError}
      />

      {/* Waiting list: every not-yet-owned upcoming book. */}
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
              <WaitingRow
                key={e.id}
                item={e}
                onRemove={(id) =>
                  removeExpected(id).catch((err) =>
                    notifyError(err instanceof Error ? err.message : 'Could not remove'),
                  )
                }
              />
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
