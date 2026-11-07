import { Rating } from 'primereact/rating';
import { Tag } from 'primereact/tag';

import { formatAuthors, formatYear } from '../format';
import { useSettings } from '../settings/SettingsContext';
import type { Book } from '../types';
import { STATUS_LABELS } from '../types';
import { BookCover, StatusTag } from '../ui';

interface Props {
  book: Book;
  onOpen: (book: Book) => void;
}

export function BookCard({ book, onOpen }: Props) {
  const { settings } = useSettings();
  const f = settings.cardFields;

  const year = formatYear(book.published_date);
  const hasSubtitle = typeof book.subtitle === 'string' && book.subtitle.trim().length > 0;
  const showSubtitle = f.subtitle && hasSubtitle;
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
      <BookCover src={book.cover_url} title={book.title} size="fill" />
      <div className="body">
        {/* Primary block: title + (for series volumes) the volume's own title as subtitle. */}
        <div className="card-heading">
          <span className="title" title={book.title}>
            {book.title}
          </span>
          {showSubtitle && (
            <span className="card-subtitle" title={book.subtitle ?? undefined}>
              {book.subtitle}
            </span>
          )}
        </div>

        {/* Secondary block: author/year, series, pages — smaller and muted. */}
        <div className="card-meta">
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
        </div>

        {f.shelves && book.shelves.length > 0 && (
          <div className="card-shelves">
            {book.shelves.map((s) => (
              <Tag key={s} value={s} severity="success" />
            ))}
          </div>
        )}

        <div className="card-footer">
          {f.status && (
            <StatusTag status={book.status} />
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
