import { Button } from 'primereact/button';
import { InputSwitch } from 'primereact/inputswitch';
import { Tag } from 'primereact/tag';

import type { OwnedVolume, SeriesSummary } from '../types';
import { BookCover, ProgressBar } from '../ui';

import './SeriesCard.css';

interface Props {
  series: SeriesSummary;
  onOpenVolume: (bookId: number) => void;
  onToggleWatch: (key: string, watch: boolean) => void;
  onRefresh: (key: string) => void;
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
 * volume list, a watch toggle, a refresh button and (for watched series) the next
 * expected release. Clicking an owned volume opens the book detail dialog.
 */
export function SeriesCard({ series, onOpenVolume, onToggleWatch, onRefresh, refreshing }: Props) {
  const totalLabel = series.total_known ?? series.owned_count;
  const progressLabel = `${series.read_count} of ${totalLabel} read`;
  const nxt = series.next_expected;

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
        <Button
          icon={refreshing ? 'pi pi-spin pi-spinner' : 'pi pi-refresh'}
          rounded
          text
          aria-label={`Refresh ${series.name}`}
          disabled={refreshing}
          onClick={() => onRefresh(series.series_key)}
        />
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
        <label className="series-card-watch">
          <InputSwitch
            checked={series.watch}
            onChange={(e) => onToggleWatch(series.series_key, !!e.value)}
            aria-label={`Watch ${series.name} for new volumes`}
          />
          <span>Watch for new volumes</span>
        </label>

        {series.watch && nxt && (nxt.title || nxt.date) && (
          <div className="series-card-next">
            <i className="pi pi-bell" aria-hidden="true" />
            <span>
              Next: {nxt.title ?? 'TBA'}
              {nxt.date && ` · ${nxt.date}`}
            </span>
            {nxt.source_url && (
              <a href={nxt.source_url} target="_blank" rel="noreferrer noopener">
                source
              </a>
            )}
          </div>
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
