import { useState } from 'react';

import { useAgentAnchor } from '../agent-ui';
import type { ReleaseEdition, ReleaseSummary } from '../types';
import { Pill } from '../ui';

import { releaseStatusVisual } from './releaseStatus';
import './SeriesReleaseWatch.css';

interface Props {
  seriesKey: string;
  seriesName: string;
  summary: ReleaseSummary | null;
  /** True while the release research is running (show a spinner instead of a status). */
  checking: boolean;
  /** Open an owned/added library book by id (for the "added to library" badge). */
  onOpenBook: (bookId: number) => void;
}

/** One per-edition row (PL / EN) shown under Details. */
function EditionRow({ lang, edition }: { lang: 'PL' | 'EN'; edition: ReleaseEdition | null | undefined }) {
  if (!edition) {
    return (
      <div className="series-release-edition">
        <span className="series-release-edition-lang">{lang}</span>
        <span className="series-release-edition-muted">not announced</span>
      </div>
    );
  }
  const visual = releaseStatusVisual(edition.status);
  return (
    <div className="series-release-edition">
      <span className="series-release-edition-lang">{lang}</span>
      <i className={`${visual.icon} series-release-edition-icon`} aria-hidden="true" />
      <span className="series-release-edition-status">{visual.label}</span>
      {edition.title && <span className="series-release-edition-title">{edition.title}</span>}
      <span className="series-release-edition-date">{edition.date ?? 'no date'}</span>
      {edition.source_url && (
        <a
          className="series-release-src"
          href={edition.source_url}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`${lang} source`}
          title="Source"
        >
          <i className="pi pi-external-link" aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

/**
 * The watch area of a series card (wave 6). Shows a single status icon + label
 * and one factual headline sentence; a "Details" toggle reveals the next
 * title/volume, expected date, per-edition PL/EN rows, the factual bullet list
 * with small source links, and an "added to library" badge when a book was added.
 * When there is no summary yet it falls back to "Not checked yet".
 */
export function SeriesReleaseWatch({ seriesKey, seriesName, summary, checking, onOpenBook }: Props) {
  const [open, setOpen] = useState(false);

  // UI-agent anchor for the Details toggle, one per series card.
  useAgentAnchor({
    id: `series.release.details.${seriesKey}`,
    kind: 'button',
    label: `Release details for ${seriesName}`,
    description:
      'Expands or collapses the release-research details (next volume, expected date, ' +
      'per-edition PL/EN rows, source bullets) for this series card. Actions: "open", ' +
      '"close", "toggle".',
    tab: 'series',
    actions: ['open', 'close', 'toggle'],
    getState: () => (open ? 'open' : 'closed'),
    invoke: (action) => {
      if (action === 'close') {
        setOpen(false);
      } else if (action === 'toggle') {
        setOpen((v) => !v);
      } else {
        setOpen(true);
      }
    },
  });

  if (checking) {
    return (
      <div className="series-release series-release--checking">
        <i className="pi pi-spin pi-spinner" aria-hidden="true" />
        <span>Checking new volumes…</span>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="series-release series-release--empty">
        <i className="pi pi-question-circle" aria-hidden="true" />
        <span>Not checked yet</span>
      </div>
    );
  }

  const visual = releaseStatusVisual(summary.status);
  const hasDetails =
    Boolean(summary.next_title) ||
    Boolean(summary.expected_date) ||
    summary.details.length > 0 ||
    Boolean(summary.editions.pl) ||
    Boolean(summary.editions.en) ||
    summary.added_book_id != null;

  return (
    <div className="series-release">
      <div className="series-release-head">
        <i
          className={`${visual.icon} series-release-icon series-release-icon--${visual.tone}`}
          aria-hidden="true"
        />
        <span className="series-release-status">{visual.label}</span>
        <span className="series-release-headline">{summary.headline}</span>
      </div>

      {hasDetails && (
        <button
          type="button"
          className="series-release-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <i className={open ? 'pi pi-chevron-up' : 'pi pi-chevron-down'} aria-hidden="true" />
          Details
        </button>
      )}

      {open && hasDetails && (
        <div className="series-release-body">
          {(summary.next_title || summary.next_volume != null || summary.expected_date) && (
            <div className="series-release-next">
              <span className="series-release-next-main">
                {summary.next_title ?? 'Next volume'}
                {summary.next_volume != null && ` · vol. ${summary.next_volume}`}
              </span>
              <span className="series-release-next-date">{summary.expected_date ?? 'no date'}</span>
            </div>
          )}

          {(summary.editions.pl || summary.editions.en) && (
            <div className="series-release-editions">
              <EditionRow lang="PL" edition={summary.editions.pl} />
              <EditionRow lang="EN" edition={summary.editions.en} />
            </div>
          )}

          {summary.details.length > 0 && (
            <ul className="series-release-bullets">
              {summary.details.map((d, i) => (
                <li key={`${i}-${d.text.slice(0, 16)}`}>
                  <span>{d.text}</span>
                  {d.source_url && (
                    <a
                      className="series-release-src"
                      href={d.source_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      aria-label="Source"
                      title="Source"
                    >
                      <i className="pi pi-external-link" aria-hidden="true" />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}

          {summary.added_book_id != null && (
            <button
              type="button"
              className="series-release-added"
              onClick={() => onOpenBook(summary.added_book_id as number)}
            >
              <Pill tone="green" dot>
                <i className="pi pi-check" aria-hidden="true" /> Added to library
              </Pill>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
