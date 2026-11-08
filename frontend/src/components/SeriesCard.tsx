import { Button } from 'primereact/button';
import { InputSwitch } from 'primereact/inputswitch';
import { Tag } from 'primereact/tag';

import type { OwnedVolume, SeriesSearchLang, SeriesSummary } from '../types';
import { BookCover, LangPicker, ProgressBar, SERIES_LANG_OPTIONS } from '../ui';

import { SeriesReleaseWatch } from './SeriesReleaseWatch';
import './SeriesCard.css';

interface Props {
  series: SeriesSummary;
  onOpenVolume: (bookId: number) => void;
  onToggleWatch: (key: string, watch: boolean) => void;
  /** Refresh the release lookup; the current search language is passed through. */
  onRefresh: (key: string, searchLang: SeriesSearchLang) => void;
  onEdit: (key: string) => void;
  /** Persist a new search language for this series (PATCH search_lang). */
  onSetLang: (key: string, lang: SeriesSearchLang) => void;
  /** Add a volume the research found as Want to read. */
  onAddVolume?: (key: string, title: string, volume: number | null) => Promise<void>;
  refreshing: boolean;
}

function volumeLabel(vol: OwnedVolume): string {
  if (vol.volume != null) {
    return `#${Number.isInteger(vol.volume) ? vol.volume : vol.volume}`;
  }
  return vol.volume_label ? `#${vol.volume_label}` : '';
}

/**
 * One series on the Series tab: owned-volume covers, a read-progress bar, the missing
 * volume list, a watch toggle, a per-series search-language control, a refresh button
 * and (for watched series) the editor-written release summary. Clicking an owned volume
 * opens the book detail dialog.
 */
export function SeriesCard({
  series,
  onOpenVolume,
  onToggleWatch,
  onRefresh,
  onEdit,
  onSetLang,
  onAddVolume,
  refreshing,
}: Props) {
  const totalLabel = series.total_known ?? series.owned_count;
  const progressLabel = `${series.read_count} of ${totalLabel} read`;
  const lang = series.search_lang ?? 'pl';

  return (
    <article className="series-card">
      <header className="series-card-head">
        <div className="series-card-title">
          <h3>{series.name}</h3>
          {series.author && <span className="series-card-author">{series.author}</span>}
          {series.aliases.length > 0 && (
            <span className="series-card-aliases" title={series.aliases.join(', ')}>
              also: {series.aliases.join(', ')}
            </span>
          )}
        </div>
        <div className="series-card-actions">
          <Button
            icon="pi pi-pencil"
            rounded
            text
            aria-label={`Edit ${series.name}`}
            onClick={() => onEdit(series.series_key)}
          />
          <Button
            icon={refreshing ? 'pi pi-spin pi-spinner' : 'pi pi-refresh'}
            rounded
            text
            aria-label={`Refresh ${series.name}`}
            disabled={refreshing}
            onClick={() => onRefresh(series.series_key, lang)}
          />
        </div>
      </header>

      <ProgressBar value={series.read_count} max={totalLabel} label={progressLabel} />

      <div className="series-card-covers">
        {series.owned_volumes.map((vol) => (
          <button
            key={vol.book_id}
            type="button"
            className={`series-vol ${vol.read ? 'series-vol--read' : ''}`}
            onClick={() => onOpenVolume(vol.book_id)}
            title={`${vol.title}${vol.volume != null ? ` (vol. ${vol.volume})` : ''}`}
            aria-label={`Open ${vol.title}`}
          >
            <BookCover src={vol.cover_url} title={vol.title} size="thumb" />
            <span className="series-vol-num">{volumeLabel(vol)}</span>
            {vol.read && <i className="pi pi-check series-vol-read" aria-hidden="true" />}
          </button>
        ))}
      </div>

      {series.missing_volumes.length > 0 && (
        <div className="series-card-missing">
          <span className="series-card-missing-label">Missing:</span>
          <div className="series-card-missing-list">
            {series.missing_volumes.map((m) => (
              <Tag
                key={`${m.number}-${m.title ?? ''}`}
                severity="warning"
                value={
                  m.title
                    ? `#${m.number ?? '?'} ${m.title}`
                    : `#${m.number ?? '?'}`
                }
              />
            ))}
          </div>
        </div>
      )}

      <footer className="series-card-foot">
        <div className="series-card-watch-row">
          <label className="series-card-watch" title="Watch for new volumes">
            <InputSwitch
              checked={series.watch}
              onChange={(e) => onToggleWatch(series.series_key, !!e.value)}
              aria-label={`Watch ${series.name} for new volumes`}
            />
            <span>New volumes</span>
          </label>
          <LangPicker
            value={lang}
            options={SERIES_LANG_OPTIONS}
            onChange={(next) => onSetLang(series.series_key, next)}
            ariaLabel={`Search language for ${series.name}`}
            className="series-card-lang"
          />
        </div>

        {series.watch && (
          <SeriesReleaseWatch
            seriesKey={series.series_key}
            seriesName={series.name}
            summary={series.release_summary}
            checking={series.checking}
            onOpenBook={onOpenVolume}
            onAddVolume={
              onAddVolume
                ? (title, volume) => onAddVolume(series.series_key, title, volume)
                : undefined
            }
          />
        )}

        {series.watch && series.last_checked && (
          <span className="series-card-checked">
            Last checked {series.last_checked.slice(0, 10)}
          </span>
        )}
      </footer>

      {series.notes && <p className="series-card-notes">{series.notes}</p>}
    </article>
  );
}
