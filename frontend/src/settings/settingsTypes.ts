/**
 * User-facing display settings, persisted to localStorage.
 *
 * `cardFields` controls which optional fields appear on a library card;
 * `detailSections` controls which sections appear in the book detail dialog.
 * `showAllDetails` is the default state of the detail dialog's "Show details"
 * toggle, which reveals the extended sections.
 */

/** Optional fields that can be shown on a library card. */
export type CardField =
  | 'author'
  | 'year'
  | 'subtitle'
  | 'status'
  | 'score'
  | 'stars'
  | 'series'
  | 'shelves'
  | 'pageCount';

/** Sections that can be shown in the book detail dialog. */
export type DetailSection =
  | 'readingDates'
  | 'pages'
  | 'score'
  | 'status'
  | 'rating'
  | 'shelves'
  | 'tags'
  | 'series'
  | 'description'
  | 'insights'
  | 'notes'
  | 'purchase'
  | 'language'
  | 'format'
  | 'added';

export const CARD_FIELDS: CardField[] = [
  'author',
  'year',
  'subtitle',
  'status',
  'score',
  'stars',
  'series',
  'shelves',
  'pageCount',
];

export const DETAIL_SECTIONS: DetailSection[] = [
  'readingDates',
  'pages',
  'score',
  'status',
  'rating',
  'shelves',
  'tags',
  'series',
  'description',
  'insights',
  'notes',
  'purchase',
  'language',
  'format',
  'added',
];

/** Human labels for the settings UI. */
export const CARD_FIELD_LABELS: Record<CardField, string> = {
  author: 'Author',
  year: 'Year',
  subtitle: 'Subtitle',
  status: 'Status badge',
  score: 'Score',
  stars: 'Stars',
  series: 'Series',
  shelves: 'Shelves',
  pageCount: 'Page count',
};

export const DETAIL_SECTION_LABELS: Record<DetailSection, string> = {
  readingDates: 'Reading dates',
  pages: 'Pages',
  score: 'Score',
  status: 'Status',
  rating: 'Rating',
  shelves: 'Shelves',
  tags: 'Tags',
  series: 'Series',
  description: 'Description',
  insights: 'Insights',
  notes: 'Notes, review & quotes',
  purchase: 'Purchase info',
  language: 'Language (PL / EN)',
  format: 'Format',
  added: 'Date added',
};

/**
 * Which detail sections belong to the "extended" group, hidden until the
 * dialog's "Show details" toggle (or the global `showAllDetails`) is on.
 * The remaining sections are always shown when enabled in settings.
 */
export const EXTENDED_DETAIL_SECTIONS: DetailSection[] = [
  'insights',
  'notes',
  'purchase',
  'series',
  'tags',
];

export interface Settings {
  cardFields: Record<CardField, boolean>;
  detailSections: Record<DetailSection, boolean>;
  /** Default state of the detail dialog "Show details" (extended) toggle. */
  showAllDetails: boolean;
  /**
   * Show the floating voice (microphone) button on the main view, next to the
   * chat bubble, so the user can talk to the UI agent without opening the chat.
   * Default on.
   */
  showVoiceButton: boolean;
  /**
   * Show the floating chat (assistant) button. Off leaves only the microphone,
   * which still drives the UI agent without opening the chat. Default on.
   */
  showChatButton: boolean;
}

function allOn<K extends string>(keys: K[]): Record<K, boolean> {
  return Object.fromEntries(keys.map((k) => [k, true])) as Record<K, boolean>;
}

export const DEFAULT_SETTINGS: Settings = {
  cardFields: allOn(CARD_FIELDS),
  detailSections: allOn(DETAIL_SECTIONS),
  showAllDetails: false,
  showVoiceButton: true,
  showChatButton: true,
};

const STORAGE_KEY = 'shelfie.settings.v1';

/**
 * Merge a stored (possibly partial or stale) settings object onto the
 * defaults so that new fields/sections introduced later default to ON.
 */
export function mergeSettings(stored: unknown): Settings {
  if (!stored || typeof stored !== 'object') {
    return DEFAULT_SETTINGS;
  }
  const s = stored as Partial<Settings>;
  return {
    cardFields: { ...DEFAULT_SETTINGS.cardFields, ...(s.cardFields ?? {}) },
    detailSections: { ...DEFAULT_SETTINGS.detailSections, ...(s.detailSections ?? {}) },
    showAllDetails:
      typeof s.showAllDetails === 'boolean'
        ? s.showAllDetails
        : DEFAULT_SETTINGS.showAllDetails,
    showVoiceButton:
      typeof s.showVoiceButton === 'boolean'
        ? s.showVoiceButton
        : DEFAULT_SETTINGS.showVoiceButton,
    showChatButton:
      typeof s.showChatButton === 'boolean' ? s.showChatButton : DEFAULT_SETTINGS.showChatButton,
  };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? mergeSettings(JSON.parse(raw)) : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage unavailable (private mode, quota): keep in-memory only.
  }
}
