/**
 * Browser-side agent tools — the **universal** (registry-driven) tool set.
 *
 * Every tool here is **defined and executed in the browser**. The JSON-Schema
 * `parameters` are sent to the backend runner so the model knows the tool exists;
 * the `execute` function runs locally when the model calls the tool.
 *
 * The UI agent used to carry one hand-written tool per action (`set_search`,
 * `set_star_filter`, `navigate`, `open_add_book`, …) and a matching case in the
 * UI bus, so a new tab meant editing the agent. It is now **generic**: controls
 * declare themselves as anchors in a runtime registry (see `../agent-ui/`), and
 * these tools read and drive that registry:
 *
 *   - `describe_ui`  — the whole UI as a schema (tabs → anchors with kind, label,
 *                      current value, allowed options, actions; lists expose items).
 *   - `get_state(id)`— read one anchor's current value.
 *   - `set(id,value)`— write a value control; validated against its options.
 *   - `invoke(id,…)` — run an action on a button / dialog / list item.
 *   - `navigate(tab)`— switch the active tab.
 *   - `find_books`   — the only data tool, still client-side: search the loaded
 *                      books so the model can resolve a name to ids/titles.
 *
 * No tool knows any specific control. Adding a tab or a control is purely a
 * `useAgentAnchor` call in that component — the agent and the backend are
 * untouched, and the navigation schema is built on the fly at runtime.
 */

import type { Book, SeriesSummary } from '../types';
import {
  describeUi,
  getAnchorState,
  invokeAnchor,
  navigate as registryNavigate,
  setAnchor,
} from '../agent-ui';

/** A tool definition: JSON schema for the model + a browser executor. */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Run the tool in the browser; return a short JSON-able result for the model. */
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

/** Series data access for the `series_releases` tool (injected; tests pass fakes). */
export interface SeriesDeps {
  list: () => Promise<SeriesSummary[]>;
  get: (key: string) => Promise<SeriesSummary>;
  /** Start the web release check; resolves with `checking: true`. */
  refresh: (key: string) => Promise<SeriesSummary>;
  pollMs?: number;
  timeoutMs?: number;
}

/** What the tool layer needs from the host app: the loaded books (live). */
export interface ToolContext {
  getBooks: () => Book[];
  series?: SeriesDeps;
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
  const describe: AgentTool = {
    name: 'describe_ui',
    description:
      'Read the whole UI as a schema built live from the app: every tab (active or not) and the ' +
      'controls (anchors) it owns, each with its id, kind, label, current value, allowed options and ' +
      'actions; lists expose their items (e.g. visible books) with ids and titles. ALWAYS call this ' +
      'FIRST to learn what you can read and change, then act with get_state / set / invoke / navigate ' +
      'using the ids you see here. Never invent an id.',
    parameters: objSchema({}),
    execute: () => {
      return { ok: true, schema: describeUi() };
    },
  };

  const getState: AgentTool = {
    name: 'get_state',
    description:
      "Read one control's current value by its anchor id (from describe_ui). Use before changing a " +
      'control when you need to know its current state.',
    parameters: objSchema({ id: { type: 'string' } }, ['id']),
    execute: (args) => {
      const id = str(args.id);
      if (!id) {
        return { ok: false, error: 'id is required' };
      }
      return getAnchorState(id);
    },
  };

  const set: AgentTool = {
    name: 'set',
    description:
      "Set a value control (text-input, search, select, toggle, multi-select) to a new value, by its " +
      'anchor id (from describe_ui). value is a string for text/search, true/false for a toggle, an ' +
      'option value for a select, or an array of option values for a multi-select. The value is ' +
      "validated against the control's allowed options; on error the result lists the valid ids/values.",
    parameters: objSchema(
      {
        id: { type: 'string' },
        value: {
          type: ['string', 'number', 'boolean', 'array', 'null'],
          items: { type: 'string' },
        },
      },
      ['id'],
    ),
    execute: async (args) => {
      const id = str(args.id);
      if (!id) {
        return { ok: false, error: 'id is required' };
      }
      return setAnchor(id, args.value);
    },
  };

  const invoke: AgentTool = {
    name: 'invoke',
    description:
      'Run an action on a control that is not a simple value — a button, a dialog (open/close), or a ' +
      'list item — by its anchor id (from describe_ui). action names the sub-action when the control ' +
      'has several (e.g. "open"/"close"); args carries parameters (e.g. { "id": 42 } to open a list ' +
      "item). The result lists the control's valid actions on error.",
    parameters: objSchema(
      {
        id: { type: 'string' },
        action: { type: 'string' },
        args: { type: 'object', additionalProperties: true },
      },
      ['id'],
    ),
    execute: async (rawArgs) => {
      const id = str(rawArgs.id);
      if (!id) {
        return { ok: false, error: 'id is required' };
      }
      const action = str(rawArgs.action);
      const args =
        rawArgs.args && typeof rawArgs.args === 'object'
          ? (rawArgs.args as Record<string, unknown>)
          : undefined;
      return invokeAnchor(id, action, args);
    },
  };

  const navigate: AgentTool = {
    name: 'navigate',
    description:
      'Switch the active tab/page. tab is a tab id from describe_ui (e.g. "library", "stats", ' +
      '"ranking", or any tab the app adds later). Use for "go to / open / show" a section.',
    parameters: objSchema({ tab: { type: 'string' } }, ['tab']),
    execute: async (args) => {
      const tab = str(args.tab);
      if (!tab) {
        return { ok: false, error: 'tab is required' };
      }
      return registryNavigate(tab);
    },
  };

  const findBooks: AgentTool = {
    name: 'find_books',
    description:
      'Search the books already loaded in the app by free text across title, author, series, shelf, ' +
      'tags and insights. Returns matching ids and titles so you can then set a filter or invoke ' +
      'open on a book. Use this to resolve a name the user said into exact books/ids — never invent ids.',
    parameters: objSchema({ query: { type: 'string' }, limit: { type: 'integer' } }, ['query']),
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

  const seriesReleases: AgentTool = {
    name: 'series_releases',
    description:
      'Answer "when does the next/last volume come out" for a series, for the POLISH and the ' +
      'ORIGINAL/ENGLISH edition. Matches the series by any of its names (e.g. "Kroniki Mroku" = ' +
      '"King\'s Dark Tidings") or by a book title in it. Returns owned/missing volumes and the ' +
      'stored next-volume info per edition (title, date, status, source). Pass refresh=true to ' +
      'search the web for release news right now (takes up to ~60 s) — do that when the stored ' +
      'info is missing, has no date, or the user asks to check. Never invent a date: report ' +
      '"not announced" when the result has no date.',
    parameters: objSchema(
      { name: { type: 'string' }, refresh: { type: 'boolean' } },
      ['name'],
    ),
    execute: async (args) => {
      const deps = ctx.series;
      if (!deps) return { ok: false, error: 'series data is not available' };
      const name = (str(args.name) ?? '').trim();
      if (!name) return { ok: false, error: 'pass a series name' };
      const all = await deps.list();
      const found = matchSeries(all, name, ctx.getBooks());
      if (!found) {
        return {
          ok: false,
          error: `no series matching "${name}"`,
          series: all.slice(0, 40).map((s) => s.name),
        };
      }
      let summary = found;
      let refreshed = false;
      if (args.refresh === true) {
        summary = await deps.refresh(found.series_key);
        const deadline = Date.now() + (deps.timeoutMs ?? 60_000);
        while (summary.checking && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, deps.pollMs ?? 2_000));
          summary = await deps.get(found.series_key);
        }
        refreshed = !summary.checking;
      }
      return { ok: true, refreshed, still_checking: summary.checking, ...seriesBrief(summary) };
    },
  };

  return [describe, getState, set, invoke, navigate, findBooks, seriesReleases];
}

/** Compact series view for the model: names, progress and the per-edition next volume. */
function seriesBrief(s: SeriesSummary): Record<string, unknown> {
  const edition = (n: SeriesSummary['next_expected_pl']) =>
    n
      ? {
          title: n.title,
          date: n.date ?? 'not announced',
          status: n.status ?? 'unknown',
          source_url: n.source_url,
          confidence: n.confidence,
        }
      : { date: 'not announced', status: 'unknown' };
  return {
    series: s.name,
    aliases: s.aliases,
    author: s.author,
    watch: s.watch,
    owned: s.owned_volumes.map((o) => ({ volume: o.volume_label ?? o.volume, title: o.title, status: o.status })),
    missing_volumes: s.missing_volumes.map((m) => m.number ?? m.title),
    total_known: s.total_known,
    last_checked: s.last_checked,
    next_polish: edition(s.next_expected_pl),
    next_original: edition(s.next_expected_en),
  };
}

const fold = (v: string): string =>
  v
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Find a series by name/alias (exact, then contains), else by a book title in it. */
export function matchSeries(
  all: SeriesSummary[],
  query: string,
  books: Book[],
): SeriesSummary | null {
  const q = fold(query);
  if (!q) return null;
  const names = (s: SeriesSummary) => [s.name, ...(s.aliases ?? [])].map(fold);
  const exact = all.find((s) => names(s).includes(q));
  if (exact) return exact;
  const partial = all.find((s) => names(s).some((n) => n.includes(q) || q.includes(n)));
  if (partial) return partial;
  // Inflected / spoken forms ("kronik mroku" for "Kroniki Mroku"): every query word is a
  // prefix of some name word, or shares its first 5 letters.
  const qWords = q.split(' ').filter((w) => w.length > 2);
  const wordHit = (qw: string, nw: string) =>
    nw.startsWith(qw) || qw.startsWith(nw) || (qw.length >= 5 && nw.slice(0, 5) === qw.slice(0, 5));
  const fuzzy = all.find((s) =>
    names(s).some((n) => {
      const nWords = n.split(' ');
      return qWords.length > 0 && qWords.every((qw) => nWords.some((nw) => wordHit(qw, nw)));
    }),
  );
  if (fuzzy) return fuzzy;
  const book = books.find((b) => b.series && fold(b.title).includes(q));
  if (book?.series) {
    const key = fold(book.series);
    return all.find((s) => names(s).includes(key)) ?? null;
  }
  return null;
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
