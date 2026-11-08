// Reusable UI building blocks. Pages import shared components from here only;
// never re-implement a component that already exists in this folder.
export { BookCover } from './BookCover';
export type { BookCoverProps, BookCoverSize } from './BookCover';
export { FavouriteToggle } from './FavouriteToggle';
export type { FavouriteToggleProps } from './FavouriteToggle';
export { ProgressBar } from './ProgressBar';
export type { ProgressBarProps } from './ProgressBar';
export { SearchInput } from './SearchInput';
export type { SearchInputProps } from './SearchInput';
export { FilterBar } from './FilterBar';
export type { FilterBarProps, FilterOption } from './FilterBar';
export { StatusTag } from './StatusTag';
export { LangPicker, SERIES_LANG_OPTIONS } from './LangPicker';
export type { LangOption, LangPickerProps } from './LangPicker';

// Design-system primitives (the "quiet dashboard" look). Generic by design so new
// tabs (Series, Favourites, …) can adopt them directly.
export { Panel } from './Panel';
export type { PanelProps, PanelTint } from './Panel';
export { SectionLabel } from './SectionLabel';
export type { SectionLabelProps } from './SectionLabel';
export { StatCard } from './StatCard';
export type { StatCardProps, StatTone } from './StatCard';
export { Sparkline } from './Sparkline';
export type { SparklineProps } from './Sparkline';
export { Pill } from './Pill';
export type { PillProps, PillTone } from './Pill';

// Auth screen primitives (login, setup, change-password). Shared so the auth
// screens never re-implement the card, field, or inline message.
export { AuthCard } from './AuthCard';
export type { AuthCardProps } from './AuthCard';
export { AuthField } from './AuthField';
export type { AuthFieldProps } from './AuthField';
export { AuthMessage } from './AuthMessage';
export type { AuthMessageProps } from './AuthMessage';
