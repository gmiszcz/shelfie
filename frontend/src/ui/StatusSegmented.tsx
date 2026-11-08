import type { ReadingStatus } from '../types';
import { STATUS_LABELS } from '../types';
import './StatusSegmented.css';

/** Short labels + icons so all four fit in one row on a phone. */
const ITEMS: { value: ReadingStatus; label: string; icon: string }[] = [
  { value: 'want', label: 'Want', icon: 'pi pi-bookmark' },
  { value: 'reading', label: 'Reading', icon: 'pi pi-book' },
  { value: 'finished', label: 'Finished', icon: 'pi pi-check-circle' },
  { value: 'abandoned', label: 'Dropped', icon: 'pi pi-times-circle' },
];

export interface StatusSegmentedProps {
  value: ReadingStatus;
  onChange: (next: ReadingStatus) => void;
}

/**
 * The reading status as one row of four buttons (like most book trackers): one tap sets it,
 * the active one is tinted in that status' colour. A radiogroup for screen readers.
 */
export function StatusSegmented({ value, onChange }: StatusSegmentedProps) {
  return (
    <div className="ui-status-seg" role="radiogroup" aria-label="Reading status">
      {ITEMS.map((item) => {
        const on = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={STATUS_LABELS[item.value]}
            className={`ui-status-seg-item ui-status-seg-item--${item.value}${on ? ' is-on' : ''}`}
            onClick={() => {
              if (!on) onChange(item.value);
            }}
          >
            <i className={item.icon} aria-hidden="true" />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
