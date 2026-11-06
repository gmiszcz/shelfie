import { Rating } from 'primereact/rating';
import { Tag } from 'primereact/tag';

import { formatAuthors, formatYear } from '../format';
import type { Book } from '../types';
import { STATUS_LABELS, STATUS_SEVERITY } from '../types';

interface Props {
  book: Book;
  onOpen: (book: Book) => void;
}

export function BookCard({ book, onOpen }: Props) {
  return (
    <div
      className="book-card"
      onClick={() => onOpen(book)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(book);
      }}
    >
      <div className="cover">
        {book.cover_url ? (
          <img src={book.cover_url} alt={`Cover of ${book.title}`} loading="lazy" />
        ) : (
          <i className="pi pi-book" style={{ fontSize: '2rem' }} />
        )}
      </div>
      <div className="body">
        <span className="title" title={book.title}>
          {book.title}
        </span>
        <span className="author">
          {formatAuthors(book.authors)}
          {formatYear(book.published_date) && ` · ${formatYear(book.published_date)}`}
        </span>
        <div className="card-footer">
          <Tag value={STATUS_LABELS[book.status]} severity={STATUS_SEVERITY[book.status]} />
          {book.stars != null && (
            <Rating value={Math.round(book.stars)} readOnly cancel={false} />
          )}
        </div>
      </div>
    </div>
  );
}
