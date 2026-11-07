/**
 * Short, human-readable labels for the UI agent's action cards, shown in the
 * chat when the browser executes a tool. Pure functions — unit-testable.
 */

const TAB_LABELS: Record<string, string> = {
  library: 'Library',
  stats: 'Statistics',
  ranking: 'Ranking',
};

function facetSummary(args: Record<string, unknown>): string {
  const parts: string[] = [];
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() : '');
  if (s('series')) parts.push(`series ${s('series')}`);
  if (s('author')) parts.push(`author ${s('author')}`);
  if (s('shelf')) parts.push(`shelf ${s('shelf')}`);
  if (s('tag')) parts.push(`tag ${s('tag')}`);
  if (s('status')) parts.push(`status ${s('status')}`);
  if (s('query')) parts.push(`"${s('query')}"`);
  if (typeof args.min_stars === 'number' && args.min_stars > 0) parts.push(`min ${args.min_stars}★`);
  if (Array.isArray(args.book_ids) && args.book_ids.length) parts.push(`${args.book_ids.length} books`);
  return parts.join(', ');
}

/** A short "what the agent did" label for a tool name + its arguments. */
export function describeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'navigate': {
      const tab = typeof args.tab === 'string' ? args.tab : '';
      return `Go to ${TAB_LABELS[tab] ?? tab}`;
    }
    case 'set_search':
      return `Search library "${String(args.query ?? '')}"`;
    case 'set_star_filter':
      return args.stars == null ? 'Clear star filter' : `Filter ${args.stars}★`;
    case 'filter_library': {
      const sum = facetSummary(args);
      return sum ? `Filter library: ${sum}` : 'Filter library';
    }
    case 'clear_filter':
      return 'Clear library filter';
    case 'open_book':
      return `Open book #${String(args.book_id ?? '')}`;
    case 'open_add_book': {
      const mode = args.mode === 'manual' ? 'manual form' : 'search';
      const q = typeof args.query === 'string' && args.query ? ` "${args.query}"` : '';
      return `Add a book (${mode}${q})`;
    }
    case 'open_settings':
      return 'Open settings';
    case 'close_dialogs':
      return 'Close dialogs';
    case 'set_setting':
      return `Setting ${String(args.key ?? '')} → ${args.value ? 'on' : 'off'}`;
    case 'toggle_theme':
      return 'Toggle theme';
    case 'ranking_search':
      return `Ranking search "${String(args.query ?? '')}"`;
    case 'get_ui_state':
      return 'Read UI state';
    case 'find_books':
      return `Find books "${String(args.query ?? '')}"`;
    default:
      return name;
  }
}
