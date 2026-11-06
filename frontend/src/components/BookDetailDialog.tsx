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
}

const STATUS_OPTIONS = (Object.keys(STATUS_LABELS) as ReadingStatus[]).map((value) => ({
  value,
  label: STATUS_LABELS[value],
}));

export function BookDetailDialog({ book, onHide, onStatus, onStars, onDelete }: Props) {
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
        </div>
      </div>

      {book.description && (
        <>
          <h4>Description</h4>
          <div className="detail-description">{book.description}</div>
        </>
      )}

      <div className="flex justify-content-end mt-3">
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
