import { Button } from 'primereact/button';
import { useEffect } from 'react';

import './ComparePair.css';
import { HalfStarRating } from './HalfStarRating';
import { formatAuthors } from '../format';
import { formatScore } from '../ranking';
import type { Book, Winner } from '../types';

interface Props {
  left: Book;
  right: Book;
  /** True while a choice is being sent to the API. */
  sending: boolean;
  onChoose: (winner: Winner) => void;
}

/** Is the user currently typing in a text field? Keyboard shortcuts stay off then. */
function typingInField(): boolean {
  const el = document.activeElement;
  if (!el) {
    return false;
  }
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

function Side({
  book,
  side,
  sending,
  onChoose,
}: {
  book: Book;
  side: 'left' | 'right';
  sending: boolean;
  onChoose: (winner: Winner) => void;
}) {
  return (
    <div className="compare-card">
      <div className="compare-cover">
        {book.cover_url ? (
          <img src={book.cover_url} alt={`Cover of ${book.title}`} loading="lazy" />
        ) : (
          <i className="pi pi-book" style={{ fontSize: '2.5rem' }} />
        )}
      </div>
      <div className="compare-meta">
        <span className="compare-title" title={book.title}>
          {book.title}
        </span>
        <span className="compare-authors">{formatAuthors(book.authors)}</span>
        <div className="compare-stats">
          {book.stars != null && (
            <HalfStarRating
              value={book.stars}
              onChange={() => {}}
              readOnly
              ariaLabel={`${book.stars} stars`}
            />
          )}
          <span className="compare-score">{formatScore(book)}</span>
        </div>
      </div>
      <Button
        label="I preferred this"
        icon="pi pi-check"
        onClick={() => onChoose(side)}
        disabled={sending}
        loading={sending}
        className="compare-pick"
      />
    </div>
  );
}

export function ComparePair({ left, right, sending, onChoose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sending || typingInField()) {
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onChoose('left');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        onChoose('right');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        onChoose('tie');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sending, onChoose]);

  return (
    <div className="compare">
      <div className="compare-pair">
        <Side book={left} side="left" sending={sending} onChoose={onChoose} />
        <div className="compare-vs">vs</div>
        <Side book={right} side="right" sending={sending} onChoose={onChoose} />
      </div>
      <div className="compare-tie">
        <Button
          label="About the same"
          icon="pi pi-equals"
          severity="secondary"
          outlined
          onClick={() => onChoose('tie')}
          disabled={sending}
        />
        <span className="compare-hint">
          Shortcuts: <kbd>←</kbd> left · <kbd>→</kbd> right · <kbd>↓</kbd> tie
        </span>
      </div>
    </div>
  );
}
