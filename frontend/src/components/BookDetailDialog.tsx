import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { Dropdown } from 'primereact/dropdown';
import { InputSwitch } from 'primereact/inputswitch';
import { Rating } from 'primereact/rating';
import { Tag } from 'primereact/tag';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { formatAuthors, formatYear } from '../format';
import { useSettings } from '../settings/SettingsContext';
import type { DetailSection } from '../settings/settingsTypes';
import type { Book, BookInsights, ReadingStatus } from '../types';
import { STATUS_LABELS, STATUS_SEVERITY } from '../types';

interface Props {
  book: Book | null;
  onHide: () => void;
  onStatus: (id: number, status: ReadingStatus) => void;
  onStars: (id: number, stars: number | null) => void;
  onDelete: (id: number) => void;
  onEdit: (id: number) => void;
}

const STATUS_OPTIONS = (Object.keys(STATUS_LABELS) as ReadingStatus[]).map((value) => ({
  value,
  label: STATUS_LABELS[value],
}));

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

export function BookDetailDialog({ book, onHide, onStatus, onStars, onDelete, onEdit }: Props) {
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
        <div className="cover detail-cover">
          {book.cover_url ? (
            <img
              src={book.cover_url}
              alt={`Cover of ${book.title}`}
              style={{ width: '100%', borderRadius: 'var(--custom-border-radius)' }}
            />
          ) : (
            <i className="pi pi-book" style={{ fontSize: '2rem' }} />
          )}
        </div>

        <div className="detail-meta">
          {book.subtitle && <em>{book.subtitle}</em>}
          <div>
            <strong>{formatAuthors(book.authors)}</strong>
            {year && ` · ${year}`}
            {book.publisher && ` · ${book.publisher}`}
          </div>

          {book.translators.length > 0 && (
            <div style={{ color: 'var(--app-text-muted)' }}>
              Translated by {formatAuthors(book.translators)}
            </div>
          )}

          {on('status') && (
            <div className="flex align-items-center gap-2">
              <span>Status:</span>
              <Dropdown
                value={book.status}
                options={STATUS_OPTIONS}
                onChange={(e) => onStatus(book.id, e.value as ReadingStatus)}
              />
              <Tag value={STATUS_LABELS[book.status]} severity={STATUS_SEVERITY[book.status]} />
            </div>
          )}

          {on('rating') && (
            <div className="flex align-items-center gap-2">
              <span>Rating:</span>
              <Rating
                value={book.stars ?? 0}
                onChange={(e) => onStars(book.id, e.value ?? null)}
                cancel
              />
            </div>
          )}

          {on('score') && book.display_score != null && (
            <div className="flex align-items-center gap-2">
              <Tag value={`Score ${book.display_score.toFixed(1)}`} severity="info" />
            </div>
          )}

          {on('readingDates') && (book.started_on || book.finished_on) && (
            <div className="flex gap-3 flex-wrap" style={{ color: 'var(--app-text-muted)' }}>
              {book.started_on && <span>Started {book.started_on}</span>}
              {book.finished_on && <span>Finished {book.finished_on}</span>}
            </div>
          )}

          {on('pages') && (hasPositive(book.page_count) || hasPositive(book.pages_read)) && (
            <div style={{ color: 'var(--app-text-muted)' }}>
              {hasPositive(book.pages_read) && `${book.pages_read} read`}
              {hasPositive(book.pages_read) && hasPositive(book.page_count) && ' / '}
              {hasPositive(book.page_count) && `${book.page_count} pages`}
            </div>
          )}

          {on('shelves') && book.shelves.length > 0 && (
            <div className="flex gap-1 flex-wrap align-items-center">
              <span style={{ color: 'var(--app-text-muted)' }}>Shelves:</span>
              {book.shelves.map((s) => (
                <Tag key={s} value={s} severity="success" />
              ))}
            </div>
          )}

          {book.categories.length > 0 && (
            <div className="flex gap-1 flex-wrap">
              {book.categories.map((c) => (
                <Tag key={c} value={c} />
              ))}
            </div>
          )}

          <Field label="Format" value={nonEmpty(book.format) ? book.format : null} />
          <Field label="Edition" value={nonEmpty(book.edition) ? book.edition : null} />
          {book.language && <Field label="Language" value={book.language} />}
          {hasPositive(book.copies) && book.copies > 1 && (
            <Field label="Copies" value={book.copies} />
          )}
          {book.signed && <Field label="Signed" value="Yes" />}
          <Field label="Condition" value={nonEmpty(book.condition) ? book.condition : null} />
          {nonEmpty(book.added_at) && <Field label="Added" value={book.added_at} />}
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

      <div className="flex justify-content-between mt-3">
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
