import { Skeleton } from 'primereact/skeleton';

import type { Book } from '../types';
import { BookCard } from './BookCard';

interface Props {
  books: Book[];
  loading: boolean;
  onOpen: (book: Book) => void;
}

export function BookGrid({ books, loading, onOpen }: Props) {
  if (loading) {
    return (
      <div className="book-grid">
        {Array.from({ length: 12 }).map((_, i) => (
          <div className="book-card" key={i}>
            <Skeleton width="100%" height="0" style={{ aspectRatio: '2 / 3' }} />
            <div className="body">
              <Skeleton width="90%" height="1rem" />
              <Skeleton width="60%" height="0.8rem" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (books.length === 0) {
    return (
      <div className="empty-state">
        <i className="pi pi-book" style={{ fontSize: '2.5rem' }} />
        <p>Your library is empty. Search Google Books to add your first book.</p>
      </div>
    );
  }

  return (
    <div className="book-grid">
      {books.map((book) => (
        <BookCard key={book.id} book={book} onOpen={onOpen} />
      ))}
    </div>
  );
}
