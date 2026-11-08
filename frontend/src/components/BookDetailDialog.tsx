import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { InputSwitch } from 'primereact/inputswitch';
import { Tag } from 'primereact/tag';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { formatAuthors, formatYear } from '../format';
import { HalfStarRating } from './HalfStarRating';
import { useSettings } from '../settings/SettingsContext';
import type { DetailSection } from '../settings/settingsTypes';
import type { Book, BookInsights, ReadingStatus } from '../types';
import { BookCover, FavouriteToggle, StatusSegmented } from '../ui';

interface Props {
  book: Book | null;
  onHide: () => void;
  onStatus: (id: number, status: ReadingStatus) => void;
  onStars: (id: number, stars: number | null) => void;
  onDelete: (id: number) => void;
  onEdit: (id: number) => void;
  /** When provided, a heart toggle is shown next to the title. */
  onFavourite?: (id: number, next: boolean) => void;
}

/** A number is "meaningful" only when present and positive (hides 0 pages etc.). */
function hasPositive(n: number | null | undefined): n is number {
  return typeof n === 'number' && n > 0;
}

function nonEmpty(s: string | null | undefined): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

/** True if the insights object carries any renderable field. */
function hasInsights(ins: BookInsights | null | undefined): ins is BookInsights {
  return (
    !!ins &&
    [ins.summary, ins.main_characters, ins.main_plot, ins.setting, ins.themes, ins.tone].some(
      nonEmpty,
    )
  );
}

/** A labelled key/value row, rendered only when the value is non-empty. */
function Field({ label, value }: { label: string; value: ReactNode }) {
  if (value == null || value === '' || value === false) {
    return null;
  }
  return (
    <div className="detail-field">
      <span className="detail-field-label">{label}</span>
      <span className="detail-field-value">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="detail-section">
      {title && <h4>{title}</h4>}
      {children}
    </section>
  );
}

export function BookDetailDialog({
  book,
  onHide,
  onStatus,
  onStars,
  onDelete,
  onEdit,
  onFavourite,
}: Props) {
  const { settings } = useSettings();
  const [showDetails, setShowDetails] = useState(settings.showAllDetails);

  // Reset the per-dialog toggle to the configured default each time a book opens.
  useEffect(() => {
    if (book) {
      setShowDetails(settings.showAllDetails);
    }
  }, [book, settings.showAllDetails]);

  if (!book) {
    return null;
  }

  const on = (section: DetailSection) => settings.detailSections[section];

  const year = formatYear(book.published_date);
  const insights = book.insights;

  // Which extended sections actually have content to show.
  const purchaseItems = [
    nonEmpty(book.purchase_date) ? `on ${book.purchase_date}` : null,
    hasPositive(book.purchase_price) ? `${book.purchase_price}` : null,
    nonEmpty(book.purchase_from) ? `from ${book.purchase_from}` : null,
  ].filter(Boolean);

  const hasPurchase = purchaseItems.length > 0;
  const hasNotes = nonEmpty(book.review) || nonEmpty(book.notes) || nonEmpty(book.quotes);
  const hasExtended =
    (on('insights') && hasInsights(insights)) ||
    (on('notes') && hasNotes) ||
    (on('purchase') && hasPurchase) ||
    (on('tags') && book.tags.length > 0) ||
    (on('series') && nonEmpty(book.series));

  return (
    <Dialog
      header={book.title}
      visible={!!book}
      onHide={onHide}
      style={{ width: 'min(760px, 94vw)' }}
      dismissableMask
    >
      <div className="detail-grid">
        {/* The heart sits ON the cover, exactly like on the library card. */}
        <div className="detail-cover">
          <BookCover src={book.cover_url} title={book.title} size="detail" />
          {onFavourite && (
            <FavouriteToggle
              variant="overlay"
              value={book.favourite}
              onChange={(next) => onFavourite(book.id, next)}
            />
          )}
        </div>

        <div className="detail-meta">
          {book.subtitle && <p className="detail-subtitle">{book.subtitle}</p>}
          <div className="detail-byline">
            <span>
              <strong>{formatAuthors(book.authors)}</strong>
              {year && ` · ${year}`}
              {book.publisher && ` · ${book.publisher}`}
            </span>
            {/* Just the code (PL / EN): short, no label. */}
            {on('language') && nonEmpty(book.language) && (
              <span className="detail-lang" data-detail="language" title="Language">
                {book.language.toUpperCase()}
              </span>
            )}
          </div>

          {book.translators.length > 0 && (
            <div style={{ color: 'var(--app-text-muted)' }}>
              Translated by {formatAuthors(book.translators)}
            </div>
          )}

          {/* Status: four one-tap buttons (no dropdown), like other book trackers. */}
          {on('status') && (
            <div data-detail="status">
              <StatusSegmented value={book.status} onChange={(s) => onStatus(book.id, s)} />
            </div>
          )}

          {/* Rating row: your stars, then the refined score as a small number. */}
          {(on('rating') || on('score')) && (
            <div className="detail-row">
              {(on('rating') || on('score')) && (
                <div className="detail-rating">
                  {on('rating') && (
                    <span data-detail="rating" className="detail-stars">
                      <HalfStarRating
                        value={book.stars}
                        onChange={(value) => onStars(book.id, value)}
                        ariaLabel="Your rating"
                        hideClear
                      />
                    </span>
                  )}
                  {on('score') && book.display_score != null && (
                    <span className="detail-score" data-detail="score" title="Score">
                      {book.display_score.toFixed(1)}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Dates and pages on one quiet line. */}
          {(() => {
            const bits: ReactNode[] = [];
            if (on('readingDates') && book.started_on) {
              bits.push(<span key="s" data-detail="readingDates">Started {book.started_on}</span>);
            }
            if (on('readingDates') && book.finished_on) {
              bits.push(
                <span key="f" data-detail="readingDates">
                  Finished {book.finished_on}
                </span>,
              );
            }
            return bits.length > 0 ? <div className="detail-line">{bits}</div> : null;
          })()}

          {/* Chips: shelves, categories, format and edition — no labels. */}
          {(() => {
            const chips: ReactNode[] = [];
            if (on('shelves')) {
              book.shelves.forEach((s) =>
                chips.push(
                  <span key={`s-${s}`} data-detail="shelves">
                    <Tag value={s} severity="success" />
                  </span>,
                ),
              );
            }
            book.categories.forEach((c) => chips.push(<Tag key={`c-${c}`} value={c} />));
            if (on('format') && nonEmpty(book.format)) {
              chips.push(
                <span key="fmt" className="detail-chip" data-detail="format" title="Format">
                  {book.format}
                </span>,
              );
            }
            if (nonEmpty(book.edition)) {
              chips.push(
                <span key="ed" className="detail-chip" title="Edition">
                  {book.edition}
                </span>,
              );
            }
            return chips.length > 0 ? <div className="detail-chips">{chips}</div> : null;
          })()}

          {/* Small facts on one quiet line. */}
          {(() => {
            const facts: ReactNode[] = [];
            if (hasPositive(book.copies) && book.copies > 1) {
              facts.push(<span key="cp">{book.copies} copies</span>);
            }
            if (book.signed) facts.push(<span key="sg">Signed</span>);
            if (nonEmpty(book.condition)) facts.push(<span key="cd">{book.condition}</span>);
            if (on('added') && nonEmpty(book.added_at)) {
              facts.push(
                <span key="ad" data-detail="added">
                  Added {book.added_at.slice(0, 10)}
                </span>,
              );
            }
            // Pages sit to the right of "Added" (same quiet line).
            if (on('pages') && (hasPositive(book.page_count) || hasPositive(book.pages_read))) {
              const pages = hasPositive(book.page_count) ? book.page_count : book.pages_read;
              facts.push(
                <span key="p" data-detail="pages">
                  {pages} pages
                </span>,
              );
            }
            return facts.length > 0 ? <div className="detail-line">{facts}</div> : null;
          })()}
        </div>
      </div>

      {on('description') && book.description && (
        <Section title="Description">
          <div className="detail-description">{book.description}</div>
        </Section>
      )}

      {hasExtended && (
        <div className="detail-show-toggle">
          <InputSwitch checked={showDetails} onChange={(e) => setShowDetails(!!e.value)} />
          <span>Show details</span>
        </div>
      )}

      {showDetails && (
        <>
          {on('series') && nonEmpty(book.series) && (
            <Section title="Series">
              <div>
                <strong>{book.series}</strong>
                {book.volume && ` · Vol. ${book.volume}`}
              </div>
            </Section>
          )}

          {on('tags') && book.tags.length > 0 && (
            <Section title="Tags">
              <div className="flex gap-1 flex-wrap">
                {book.tags.map((t) => (
                  <Tag key={t} value={t} severity="warning" />
                ))}
              </div>
            </Section>
          )}

          {on('insights') && hasInsights(insights) && (
            <Section title="Insights">
              <div className="detail-insights">
                <Field label="Summary" value={insights.summary} />
                <Field label="Main characters" value={insights.main_characters} />
                <Field label="Main plot" value={insights.main_plot} />
                <Field label="Setting" value={insights.setting} />
                <Field label="Themes" value={insights.themes} />
                <Field label="Tone" value={insights.tone} />
              </div>
            </Section>
          )}

          {on('notes') && hasNotes && (
            <Section title="Notes">
              {nonEmpty(book.review) && (
                <div className="detail-note">
                  <h5>Review</h5>
                  <p>{book.review}</p>
                </div>
              )}
              {nonEmpty(book.notes) && (
                <div className="detail-note">
                  <h5>Notes</h5>
                  <p>{book.notes}</p>
                </div>
              )}
              {nonEmpty(book.quotes) && (
                <div className="detail-note">
                  <h5>Quotes</h5>
                  <p className="detail-quote">{book.quotes}</p>
                </div>
              )}
            </Section>
          )}

          {on('purchase') && hasPurchase && (
            <Section title="Purchase">
              <div style={{ color: 'var(--app-text-muted)' }}>
                Bought {purchaseItems.join(' · ')}
              </div>
            </Section>
          )}
        </>
      )}

      <div className="detail-actions">
        <Button label="Edit" icon="pi pi-pencil" outlined onClick={() => onEdit(book.id)} />
        <Button
          label="Remove from library"
          icon="pi pi-trash"
          severity="danger"
          outlined
          onClick={() => onDelete(book.id)}
        />
      </div>
    </Dialog>
  );
}
