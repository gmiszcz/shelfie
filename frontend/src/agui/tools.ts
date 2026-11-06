/**
 * Browser-side agent tools (the AG-UI *frontend tools* pattern).
 *
 * Every tool here is **defined and executed in the browser**. The JSON-Schema
 * `parameters` are sent to the backend runner so the model knows the tool exists;
 * the `execute` function runs locally when the model calls the tool — it dispatches
 * a `shelfie:ui` bus event (and waits for the ack), reads `window.__shelfieUiState`,
 * or searches the books already loaded in the frontend. The backend never runs any
 * of this and has no database access.
 *
 * `find_books` is the agent's only "data" tool and it is still client-side: it
 * searches the in-memory book list the app already loaded, so the model can resolve
 * a title / author / series to concrete ids before driving the UI.
 */

import type { Book } from '../types';
import { dispatchAndWait, readUiState, type AddBookPrefill, type StarFilterValue } from './bus';

/** A tool definition: JSON schema for the model + a browser executor. */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Run the tool in the browser; return a short JSON-able result for the model. */
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

/** What the tool layer needs from the host app: the loaded books (live). */
export interface ToolContext {
  getBooks: () => Book[];
}

const objSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
const numMaybe = (v: unknown): number | undefined =>
  typeof v === 'number' && !Number.isNaN(v) ? v : undefined;

function toStarFilter(v: unknown): StarFilterValue {
  const n = numMaybe(v);
  if (n == null) {
    return null;
  }
  const rounded = Math.round(n);
  return rounded >= 1 && rounded <= 5 ? (rounded as 1 | 2 | 3 | 4 | 5) : null;
}

/** Lower-cased searchable text of a book (title/author/series/shelf/tags/insights). */
function haystack(book: Book): string {
  const insights = book.insights
    ? Object.values(book.insights).filter((x): x is string => typeof x === 'string')
    : [];
  return [
    book.title,
    book.subtitle ?? '',
    book.series ?? '',
    ...book.authors,
    ...(book.shelves ?? []),
    ...(book.tags ?? []),
    ...insights,
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * Build the agent's tool set, bound to a host context (so `find_books` can read
 * the live book list). Returns the tools in a stable order.
 */
export function createTools(ctx: ToolContext): AgentTool[] {
  const navigate: AgentTool = {
    name: 'navigate',
    description:
      'Switch the active page/tab. Use for "go to / open / show" a section: library grid, statistics, or ranking.',
    parameters: objSchema(
      { tab: { type: 'string', enum: ['library', 'stats', 'ranking'] } },
      ['tab'],
    ),
    execute: async (args) => {
      const tab = str(args.tab);
      if (tab !== 'library' && tab !== 'stats' && tab !== 'ranking') {
        return { ok: false, error: `unknown tab ${String(args.tab)}` };
      }
      const ack = await dispatchAndWait({ action: 'navigate', tab });
      return { ok: ack.ok, tab, info: ack.info };
    },
  };

  const setSearch: AgentTool = {
    name: 'set_search',
    description: 'Type text into the library search box (navigates to the library first).',
    parameters: objSchema({ query: { type: 'string' } }, ['query']),
    execute: async (args) => {
      const query = str(args.query) ?? '';
      const ack = await dispatchAndWait({ action: 'set_search', query });
      return { ok: ack.ok, query, info: ack.info };
    },
  };

  const setStarFilter: AgentTool = {
    name: 'set_star_filter',
    description:
      'Set the whole-star rating filter in the library. stars is 1..5, or null to clear it. 5 shows books rated 4.6–5.0, 4 shows 3.6–4.5, etc.',
    parameters: objSchema({
      stars: { type: ['integer', 'null'], enum: [1, 2, 3, 4, 5, null] },
    }),
    execute: async (args) => {
      const stars = toStarFilter(args.stars);
      const ack = await dispatchAndWait({ action: 'set_star_filter', stars });
      return { ok: ack.ok, stars, info: ack.info };
    },
  };

  const filterLibrary: AgentTool = {
    name: 'filter_library',
    description:
      'Filter the library grid by one or more facets (series, author, shelf, tag, status, free-text query, min_stars, or explicit book_ids). Resolve exact names/ids with find_books first. Switches to the library tab.',
    parameters: objSchema({
      query: { type: 'string' },
      series: { type: 'string' },
      author: { type: 'string' },
      shelf: { type: 'string' },
      tag: { type: 'string' },
      status: { type: 'string', enum: ['want', 'reading', 'finished', 'abandoned'] },
      min_stars: { type: 'number' },
      book_ids: { type: 'array', items: { type: 'integer' } },
    }),
    execute: async (args) => {
      const detail: {
        action: 'filter_library';
        query?: string;
        series?: string;
        author?: string;
        shelf?: string;
        tag?: string;
        status?: string;
        min_stars?: number;
        book_ids?: number[];
      } = { action: 'filter_library' };
      for (const key of ['query', 'series', 'author', 'shelf', 'tag', 'status'] as const) {
        const v = str(args[key]);
        if (v !== undefined) {
          detail[key] = v;
        }
      }
      const minStars = numMaybe(args.min_stars);
      if (minStars != null && minStars > 0) {
        detail.min_stars = minStars;
      }
      if (Array.isArray(args.book_ids)) {
        const ids = args.book_ids.filter((n): n is number => typeof n === 'number');
        if (ids.length) {
          detail.book_ids = ids;
        }
      }
      const ack = await dispatchAndWait(detail);
      return { ok: ack.ok, applied: detail, info: ack.info };
    },
  };

  const clearFilter: AgentTool = {
    name: 'clear_filter',
    description: 'Remove the assistant library filter and show the whole library again.',
    parameters: objSchema({}),
    execute: async () => {
      const ack = await dispatchAndWait({ action: 'clear_filter' });
      return { ok: ack.ok, info: ack.info };
    },
  };

  const openBook: AgentTool = {
    name: 'open_book',
    description: 'Open the detail dialog for one book by its id (from find_books).',
    parameters: objSchema({ book_id: { type: 'integer' } }, ['book_id']),
    execute: async (args) => {
      const bookId = numMaybe(args.book_id);
      if (bookId == null) {
        return { ok: false, error: 'book_id is required' };
      }
      const ack = await dispatchAndWait({ action: 'open_book', book_id: bookId });
      return { ok: ack.ok, book_id: bookId, info: ack.info };
    },
  };

  const openAddBook: AgentTool = {
    name: 'open_add_book',
    description:
      'Open the "add a book" flow. mode "search" opens the Google-search dialog (optionally with a query typed, e.g. the book title the user wants to add); mode "manual" opens the manual add form (optionally prefilled).',
    parameters: objSchema(
      {
        mode: { type: 'string', enum: ['search', 'manual'] },
        query: { type: 'string' },
        prefill: { type: 'object', additionalProperties: true },
      },
      ['mode'],
    ),
    execute: async (args) => {
      const mode = str(args.mode) === 'manual' ? 'manual' : 'search';
      const query = str(args.query);
      const prefill =
        args.prefill && typeof args.prefill === 'object'
          ? (args.prefill as AddBookPrefill)
          : undefined;
      const ack = await dispatchAndWait({ action: 'open_add_book', mode, query, prefill });
      return { ok: ack.ok, mode, query, info: ack.info };
    },
  };

  const openSettings: AgentTool = {
    name: 'open_settings',
    description: 'Open the settings sidebar.',
    parameters: objSchema({}),
    execute: async () => {
      const ack = await dispatchAndWait({ action: 'open_settings' });
      return { ok: ack.ok, info: ack.info };
    },
  };

  const setSetting: AgentTool = {
    name: 'set_setting',
    description:
      'Toggle a display setting on or off by its key (a card field, a detail section, or showAllDetails). value is boolean.',
    parameters: objSchema(
      { key: { type: 'string' }, value: { type: 'boolean' } },
      ['key', 'value'],
    ),
    execute: async (args) => {
      const key = str(args.key);
      if (!key) {
        return { ok: false, error: 'key is required' };
      }
      const value = Boolean(args.value);
      const ack = await dispatchAndWait({ action: 'set_setting', key, value });
      return { ok: ack.ok, key, value, info: ack.info };
    },
  };

  const toggleTheme: AgentTool = {
    name: 'toggle_theme',
    description: 'Switch between the dark and light theme.',
    parameters: objSchema({}),
    execute: async () => {
      const ack = await dispatchAndWait({ action: 'toggle_theme' });
      return { ok: ack.ok, info: ack.info };
    },
  };

  const rankingSearch: AgentTool = {
    name: 'ranking_search',
    description: 'Put text into the ranking page search box (navigates to the ranking tab).',
    parameters: objSchema({ query: { type: 'string' } }, ['query']),
    execute: async (args) => {
      const query = str(args.query) ?? '';
      const ack = await dispatchAndWait({ action: 'ranking', rankingAction: 'search', query });
      return { ok: ack.ok, query, info: ack.info };
    },
  };

  const getUiState: AgentTool = {
    name: 'get_ui_state',
    description:
      'Read the current UI state: active tab, search text, star filter, visible book ids, open dialog, settings. Use before deciding what to change.',
    parameters: objSchema({}),
    execute: () => {
      const state = readUiState();
      return { ok: true, state };
    },
  };

  const findBooks: AgentTool = {
    name: 'find_books',
    description:
      'Search the books already loaded in the app by free text across title, author, series, shelf, tags and insights. Returns matching ids and titles so you can then filter_library or open_book. Use this to resolve a name the user said into exact books/ids — never invent ids.',
    parameters: objSchema(
      { query: { type: 'string' }, limit: { type: 'integer' } },
      ['query'],
    ),
    execute: (args) => {
      const query = str(args.query) ?? '';
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const limit = Math.max(1, Math.min(numMaybe(args.limit) ?? 25, 50));
      const books = ctx.getBooks();
      const hits = books.filter((b) => {
        const hay = haystack(b);
        return terms.every((t) => hay.includes(t));
      });
      return {
        ok: true,
        count: hits.length,
        books: hits.slice(0, limit).map((b) => ({
          id: b.id,
          title: b.title,
          authors: b.authors,
          series: b.series ?? null,
          stars: b.stars,
          display_score: b.display_score,
        })),
      };
    },
  };

  return [
    navigate,
    setSearch,
    setStarFilter,
    filterLibrary,
    clearFilter,
    openBook,
    openAddBook,
    openSettings,
    setSetting,
    toggleTheme,
    rankingSearch,
    getUiState,
    findBooks,
  ];
}

/** JSON-schema definitions only (what is sent to the backend runner). */
export function toolSchemas(
  tools: AgentTool[],
): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}
