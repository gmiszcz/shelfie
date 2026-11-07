import './BookCover.css';

export type BookCoverSize = 'fill' | 'detail' | 'compare' | 'thumb' | 'hit';

export interface BookCoverProps {
  src: string | null | undefined;
  /** Book title, used for the image alt text. Empty string = decorative image. */
  title: string;
  /** Layout preset: 'fill' takes the parent's width; the others are fixed sizes. */
  size?: BookCoverSize;
  className?: string;
}

/**
 * The single book-cover component (card, detail dialog, compare pair, tables, search hits).
 *
 * Always a 2:3 poster box; with no image it shows a centered book icon, so an empty
 * cover never collapses into a strip.
 */
export function BookCover({ src, title, size = 'fill', className }: BookCoverProps) {
  const classes = ['ui-cover', `ui-cover--${size}`, className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      {src ? (
        <img src={src} alt={title ? `Cover of ${title}` : ''} loading="lazy" />
      ) : (
        <i className="pi pi-book ui-cover-placeholder" aria-hidden="true" />
      )}
    </div>
  );
}
