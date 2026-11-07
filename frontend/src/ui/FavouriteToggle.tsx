import './FavouriteToggle.css';

export interface FavouriteToggleProps {
  /** Whether the book is currently a favourite. */
  value: boolean;
  /** Called with the new value when the user toggles. */
  onChange: (next: boolean) => void;
  /** Accessible label; defaults describe the action. */
  title?: string;
  /** Visual size preset. "overlay" sits on top of a cover; "inline" sits in a row. */
  variant?: 'overlay' | 'inline';
  className?: string;
}

/**
 * The heart toggle used on a book cover (Library / Series / Favourites cards) and in the
 * detail dialog. It is a real <button> with an accessible name and aria-pressed, and it
 * stops click/keyboard propagation so toggling a favourite never opens the card dialog.
 */
export function FavouriteToggle({
  value,
  onChange,
  title,
  variant = 'inline',
  className,
}: FavouriteToggleProps) {
  const label = title ?? (value ? 'Remove from favourites' : 'Add to favourites');
  const classes = ['ui-fav', `ui-fav--${variant}`, value ? 'ui-fav--on' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={classes}
      aria-label={label}
      aria-pressed={value}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!value);
      }}
      onKeyDown={(e) => {
        // Keep Enter/Space from bubbling to a parent card's key handler.
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation();
        }
      }}
    >
      <i className={value ? 'pi pi-heart-fill' : 'pi pi-heart'} aria-hidden="true" />
    </button>
  );
}
