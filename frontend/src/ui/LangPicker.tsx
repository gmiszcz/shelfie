import { Dropdown } from 'primereact/dropdown';

import './LangPicker.css';

/** One choice: `code` is what the small square shows, `label` names it in the open list. */
export interface LangOption<V extends string = string> {
  value: V;
  code: string;
  label: string;
}

export interface LangPickerProps<V extends string> {
  value: V;
  options: readonly LangOption<V>[];
  onChange: (next: V) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

/**
 * LangPicker — the one small square language picker (shows "PL"; opens a list
 * "PL Polski / EN English / …"). Used by the add-book search, the series card
 * (next to Watch) and the Series settings. Rarely changed, so it stays tiny.
 */
export function LangPicker<V extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className,
}: LangPickerProps<V>) {
  return (
    <Dropdown
      value={value}
      options={options as LangOption<V>[]}
      optionValue="value"
      optionLabel="code"
      onChange={(e) => onChange(e.value as V)}
      valueTemplate={(o: LangOption<V> | null) => (
        <span>{o?.code ?? options.find((x) => x.value === value)?.code ?? ''}</span>
      )}
      itemTemplate={(o: LangOption<V>) => (
        <span className="ui-lang-item">
          <strong>{o.code}</strong> {o.label}
        </span>
      )}
      dropdownIcon={null as unknown as string}
      className={['ui-lang-picker', className ?? ''].filter(Boolean).join(' ')}
      panelClassName="ui-lang-picker-panel"
      aria-label={ariaLabel}
      title={ariaLabel}
      disabled={disabled}
    />
  );
}

/** The series research languages (PL is the default). */
export const SERIES_LANG_OPTIONS: readonly LangOption<'pl' | 'en' | 'both'>[] = [
  { value: 'pl', code: 'PL', label: 'Polski' },
  { value: 'en', code: 'EN', label: 'English' },
  { value: 'both', code: 'PL+EN', label: 'Both' },
];
