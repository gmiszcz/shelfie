import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { Dropdown } from 'primereact/dropdown';
import { Rating } from 'primereact/rating';
import { Tag } from 'primereact/tag';

import { formatAuthors, formatYear } from '../format';
import type { Book, ReadingStatus } from '../types';
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

export function BookDetailDialog({ book, onHide, onStatus, onStars, onDelete, onEdit }: Props) {
  if (!book) {
    return null;
  }
  return (
    <Dialog
      header={book.title}
      visible={!!book}
      onHide={onHide}
      style={{ width: 'min(680px, 92vw)' }}
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
            {formatYear(book.published_date) && ` · ${formatYear(book.published_date)}`}
            {book.publisher && ` · ${book.publisher}`}
          </div>

          {book.series && (
            <div>
              Series: <strong>{book.series}</strong>
              {book.volume && ` · Vol. ${book.volume}`}
            </div>
          )}

          {(book.started_on || book.finished_on) && (
            <div className="flex gap-3 flex-wrap" style={{ color: 'var(--app-text-muted)' }}>
              {book.started_on && <span>Started {book.started_on}</span>}
              {book.finished_on && <span>Finished {book.finished_on}</span>}
            </div>
          )}

          {(book.page_count != null || book.pages_read != null) && (
            <div style={{ color: 'var(--app-text-muted)' }}>
              {book.pages_read != null && `${book.pages_read} read`}
              {book.pages_read != null && book.page_count != null && ' / '}
              {book.page_count != null && `${book.page_count} pages`}
            </div>
          )}

          {book.display_score != null && (
            <div className="flex align-items-center gap-2">
              <Tag value={`Score ${book.display_score.toFixed(1)}`} severity="info" />
            </div>
          )}

          <div className="flex align-items-center gap-2">
            <span>Status:</span>
            <Dropdown
              value={book.status}
              options={STATUS_OPTIONS}
              onChange={(e) => onStatus(book.id, e.value as ReadingStatus)}
            />
            <Tag value={STATUS_LABELS[book.status]} severity={STATUS_SEVERITY[book.status]} />
          </div>

          <div className="flex align-items-center gap-2">
            <span>Rating:</span>
            <Rating
              value={book.stars ?? 0}
              onChange={(e) => onStars(book.id, e.value ?? null)}
              cancel
            />
          </div>

          {book.categories.length > 0 && (
            <div className="flex gap-1 flex-wrap">
              {book.categories.map((c) => (
                <Tag key={c} value={c} />
              ))}
            </div>
          )}

          {book.shelves.length > 0 && (
            <div className="flex gap-1 flex-wrap align-items-center">
              <span style={{ color: 'var(--app-text-muted)' }}>Shelves:</span>
              {book.shelves.map((s) => (
                <Tag key={s} value={s} severity="success" />
              ))}
            </div>
          )}

          {book.tags.length > 0 && (
            <div className="flex gap-1 flex-wrap align-items-center">
              <span style={{ color: 'var(--app-text-muted)' }}>Tags:</span>
              {book.tags.map((t) => (
                <Tag key={t} value={t} severity="warning" />
              ))}
            </div>
          )}
        </div>
      </div>

      {book.description && (
        <>
          <h4>Description</h4>
          <div className="detail-description">{book.description}</div>
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
