import { InputText } from 'primereact/inputtext';

import './SearchInput.css';

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Accessible name for the input. */
  ariaLabel: string;
  /** Stretch to the parent's width (default true). */
  fullWidth?: boolean;
  className?: string;
}

/**
 * The single search box used everywhere in the app (Library, Ranking, Statistics).
 *
 * The search icon and the clear button sit in reserved padding on each side of the
 * input, so they never overlap the text. Spacing comes only from the :root variables
 * in index.css.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search title, author or series…',
  ariaLabel,
  fullWidth = true,
  className,
}: SearchInputProps) {
  const classes = ['ui-search', fullWidth ? 'ui-search--full' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} role="search">
      <i className="pi pi-search ui-search-icon" aria-hidden="true" />
      <InputText
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        type="search"
      />
      {value && (
        <button
          type="button"
          className="ui-search-clear"
          aria-label="Clear search"
          onClick={() => onChange('')}
        >
          <i className="pi pi-times" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
