import { Button } from 'primereact/button';
import { InputSwitch } from 'primereact/inputswitch';
import { Tag } from 'primereact/tag';

import type { NextExpected, OwnedVolume, SeriesSummary } from '../types';
import { BookCover, ProgressBar } from '../ui';

import './SeriesCard.css';

interface Props {
  series: SeriesSummary;
  onOpenVolume: (bookId: number) => void;
  onToggleWatch: (key: string, watch: boolean) => void;
  onRefresh: (key: string) => void;
  onEdit: (key: string) => void;
  refreshing: boolean;
}

function volumeLabel(vol: OwnedVolume): string {
  if (vol.volume != null) {
    return `#${Number.isInteger(vol.volume) ? vol.volume : vol.volume}`;
  }
  return vol.volume_label ? `#${vol.volume_label}` : '';
}

/** One edition's next-volume line, e.g. "Ritual of Ruin · 2025-11-11 (released)" or "not announced". */
function editionLabel(edition: NextExpected | null): string {
  if (!edition || (!edition.title && !edition.date && (edition.status ?? 'unknown') === 'unknown')) {
    return 'not announced';
  }
  const parts: string[] = [];
  if (edition.title) {
    parts.push(edition.title);
  }
  if (edition.date) {
    parts.push(edition.date);
  } else if (edition.status === 'announced') {
    parts.push('date not announced');
  }
  const base = parts.join(' · ') || 'not announced';
  return edition.status && edition.status !== 'unknown' ? `${base} (${edition.status})` : base;
}

/**
 * One series on the Series tab: owned-volume covers, a read-progress bar, the missing
 * volume list, a watch toggle, a refresh button and (for watched series) the next
 * expected release. Clicking an owned volume opens the book detail dialog.
 */
export function SeriesCard({ series, onOpenVolume, onToggleWatch, onRefresh, onEdit, refreshing }: Props) {
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
            onClick={() => onRefresh(series.series_key)}
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
        <label className="series-card-watch">
          <InputSwitch
            checked={series.watch}
            onChange={(e) => onToggleWatch(series.series_key, !!e.value)}
            aria-label={`Watch ${series.name} for new volumes`}
          />
          <span>Watch for new volumes</span>
        </label>

        {series.checking && (
          <div className="series-card-checking">
            <i className="pi pi-spin pi-spinner" aria-hidden="true" />
            <span>Checking new volumes…</span>
          </div>
        )}

        {!series.checking && series.watch && (series.next_expected_pl || series.next_expected_en) && (
          <div className="series-card-next">
            <i className="pi pi-bell" aria-hidden="true" />
            <div className="series-card-next-editions">
              <span>
                PL — {editionLabel(series.next_expected_pl)}
                {series.next_expected_pl?.source_url && (
                  <a href={series.next_expected_pl.source_url} target="_blank" rel="noreferrer noopener">
                    {' '}source
                  </a>
                )}
              </span>
              <span>
                EN — {editionLabel(series.next_expected_en)}
                {series.next_expected_en?.source_url && (
                  <a href={series.next_expected_en.source_url} target="_blank" rel="noreferrer noopener">
                    {' '}source
                  </a>
                )}
              </span>
            </div>
          </div>
        )}

        {!series.checking &&
          series.watch &&
          !series.next_expected_pl &&
          !series.next_expected_en &&
          nxt &&
          (nxt.title || nxt.date) && (
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
