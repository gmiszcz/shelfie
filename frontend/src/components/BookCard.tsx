import { Rating } from 'primereact/rating';
import { Tag } from 'primereact/tag';

import { formatAuthors, formatYear } from '../format';
import { useSettings } from '../settings/SettingsContext';
import type { Book } from '../types';
import { STATUS_LABELS, STATUS_SEVERITY } from '../types';

interface Props {
  book: Book;
  onOpen: (book: Book) => void;
}

export function BookCard({ book, onOpen }: Props) {
  const { settings } = useSettings();
  const f = settings.cardFields;

  const year = formatYear(book.published_date);
  const showAuthorLine = (f.author && book.authors.length > 0) || (f.year && !!year);

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

        {showAuthorLine && (
          <span className="author">
            {f.author && formatAuthors(book.authors)}
            {f.author && f.year && year && ' · '}
            {f.year && year}
          </span>
        )}

        {f.series && book.series && (
          <span className="card-series" title={book.series}>
            <i className="pi pi-bookmark" /> {book.series}
            {book.volume && ` · Vol. ${book.volume}`}
          </span>
        )}

        {f.pageCount && book.page_count != null && book.page_count > 0 && (
          <span className="card-pages">{book.page_count} pages</span>
        )}

        {f.shelves && book.shelves.length > 0 && (
          <div className="card-shelves">
            {book.shelves.map((s) => (
              <Tag key={s} value={s} severity="success" />
            ))}
          </div>
        )}

        <div className="card-footer">
          {f.status && (
            <Tag value={STATUS_LABELS[book.status]} severity={STATUS_SEVERITY[book.status]} />
          )}
          {f.score && book.display_score != null ? (
            <Tag value={`Score ${book.display_score.toFixed(1)}`} severity="info" />
          ) : (
            f.stars &&
            book.stars != null && <Rating value={Math.round(book.stars)} readOnly cancel={false} />
          )}
        </div>
      </div>
    </div>
  );
}
