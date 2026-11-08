import type {
  Book,
  BookInput,
  BookPatch,
  ExpectedBook,
  ExpectedBookInput,
  GroupBy,
  RatingPair,
  RecomputeResult,
  SearchResponse,
  SeriesAlertsResponse,
  SeriesPreferences,
  SeriesSearchLang,
  SeriesSummary,
  StatsResponse,
  VolumeSearchResult,
  Winner,
} from '../types';
import type {
  AdminUser,
  AuthUser,
  CreatedUser,
  SetupLink,
  SetupTokenInfo,
} from '../auth/authTypes';

const BASE = '/api';

export class ApiError extends Error {
  /** Present on a 429 when the server sent a Retry-After header: seconds to wait. */
  retryAfter?: number;

  constructor(
    public status: number,
    message: string,
    retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Central 401 notification. The auth layer subscribes once; any request that
 * comes back 401 (session missing or expired) notifies every subscriber so the
 * app can drop back to the login screen while keeping the current route. Auth
 * probes (GET /api/auth/me) opt out via `silent401` so the initial "am I logged
 * in?" check does not fire the global handler.
 */
type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

function notifyUnauthorized(): void {
  for (const listener of unauthorizedListeners) {
    listener();
  }
}

async function errorFrom(resp: Response): Promise<ApiError> {
  let detail = resp.statusText;
  try {
    const body = await resp.json();
    if (typeof body.detail === 'string') {
      detail = body.detail;
    } else if (Array.isArray(body.detail)) {
      detail = body.detail.map((d: { msg?: string }) => d.msg ?? '').join('; ');
    }
  } catch {
    // non-JSON error body
  }
  let retryAfter: number | undefined;
  if (resp.status === 429) {
    const header = resp.headers.get('Retry-After');
    const parsed = header ? Number.parseInt(header, 10) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0) {
      retryAfter = parsed;
    }
  }
  return new ApiError(resp.status, detail, retryAfter);
}

/**
 * Every request is same-origin and carries `X-Shelfie-Client: web`. The cookie
 * is sent automatically on same-origin requests (and on same-origin WebSocket
 * handshakes for voice/transcribe, so those keep working without any change).
 * The client header satisfies the server's CSRF check on state-changing calls.
 *
 * `silent401` suppresses the global unauthorized handler for the one probe that
 * is allowed to see a 401 as a normal answer (the "who am I" check at startup).
 */
async function request<T>(
  path: string,
  init?: RequestInit & { silent401?: boolean },
): Promise<T> {
  const { silent401, headers, ...rest } = init ?? {};
  const resp = await fetch(`${BASE}${path}`, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Shelfie-Client': 'web',
      ...headers,
    },
    ...rest,
  });
  if (!resp.ok) {
    const err = await errorFrom(resp);
    if (resp.status === 401 && !silent401) {
      notifyUnauthorized();
    }
    throw err;
  }
  if (resp.status === 204) {
    return undefined as T;
  }
  return (await resp.json()) as T;
}

export const api = {
  listBooks: () => request<Book[]>('/books'),

  getBook: (id: number) => request<Book>(`/books/${id}`),

  /** Add a book from a search hit (with an optional starting status). */
  addBook: (volume: VolumeSearchResult, status: BookInput['status'] = 'want') =>
    request<Book>('/books', {
      method: 'POST',
      body: JSON.stringify({ ...volume, status, metadata_source: 'search' }),
    }),

  /** Create a book from a full form (manual entry). */
  createBook: (input: BookInput) =>
    request<Book>('/books', {
      method: 'POST',
      body: JSON.stringify({ metadata_source: 'manual', ...input }),
    }),

  updateBook: (id: number, changes: BookPatch) =>
    request<Book>(`/books/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    }),

  deleteBook: (id: number) => request<void>(`/books/${id}`, { method: 'DELETE' }),

  /** Regenerate structured insights for a book (POST /api/books/{id}/enrich). */
  enrichBook: (id: number) => request<Book>(`/books/${id}/enrich`, { method: 'POST' }),

  search: (q: string, lang?: string) => {
    const params = new URLSearchParams({ q });
    if (lang) {
      params.set('lang', lang);
    }
    return request<SearchResponse>(`/search?${params.toString()}`);
  },

  /** Upload a cover image; returns the URL to store in cover_url. */
  uploadCover: async (file: File): Promise<string> => {
    const form = new FormData();
    form.append('file', file);
    // Multipart body: let the browser set Content-Type (boundary); still send
    // credentials and the client header so the CSRF check and session pass.
    const resp = await fetch(`${BASE}/covers`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Shelfie-Client': 'web' },
      body: form,
    });
    if (!resp.ok) {
      const err = await errorFrom(resp);
      if (resp.status === 401) {
        notifyUnauthorized();
      }
      throw err;
    }
    return ((await resp.json()) as { url: string }).url;
  },

  stats: (groupBy: GroupBy, dateFrom?: string | null, dateTo?: string | null) => {
    const params = new URLSearchParams({ group_by: groupBy });
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    return request<StatsResponse>(`/stats?${params.toString()}`);
  },

  recomputeRatings: () => request<RecomputeResult>('/ratings/recompute', { method: 'POST' }),

  /** Next most informative pair, or null when fewer than two books are rated. */
  nextPair: async (focus?: number, group?: string | null): Promise<RatingPair | null> => {
    const params = new URLSearchParams();
    if (focus != null) {
      params.set('focus', String(focus));
    }
    if (group != null) {
      params.set('group', group);
    }
    const query = params.toString();
    const pair = await request<RatingPair | undefined>(
      `/ratings/pair${query ? `?${query}` : ''}`,
    );
    return pair ?? null;
  },

  /** Up to `count` distinct pairs for the ranking prefetch queue; `skip` = pairs already queued. */
  nextPairs: (
    count: number,
    opts: { focus?: number | null; group?: string | null; skip?: [number, number][] } = {},
  ): Promise<RatingPair[]> => {
    const params = new URLSearchParams({ count: String(count) });
    if (opts.focus != null) {
      params.set('focus', String(opts.focus));
    }
    if (opts.group != null) {
      params.set('group', opts.group);
    }
    if (opts.skip?.length) {
      params.set('skip', opts.skip.map(([a, b]) => `${a}-${b}`).join(','));
    }
    return request<RatingPair[]>(`/ratings/pairs?${params.toString()}`);
  },

  compare: (leftId: number, rightId: number, winner: Winner, sessionId = 'manual') =>
    request<RatingPair>('/ratings/compare', {
      method: 'POST',
      body: JSON.stringify({ left_id: leftId, right_id: rightId, winner, session_id: sessionId }),
    }),

  /** POST /api/agent/chat — the response body is an SSE stream; read it with chat/sse.ts. */
  chat: (
    message: string,
    sessionId: string | null,
    scope: 'library' | 'ui' = 'library',
    signal?: AbortSignal,
  ) =>
    fetch(`${BASE}/agent/chat`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Shelfie-Client': 'web',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ message, session_id: sessionId, scope }),
      signal,
    }),

  resetChat: (sessionId: string) =>
    request<void>(`/agent/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),

  // --- series tracking (wave 5) ---

  listSeries: () => request<SeriesSummary[]>('/series'),

  getSeries: (key: string) => request<SeriesSummary>(`/series/${encodeURIComponent(key)}`),

  setSeriesWatch: (key: string, watch: boolean) =>
    request<SeriesSummary>(`/series/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      body: JSON.stringify({ watch }),
    }),

  /** Edit a series' metadata (name, aliases, author, total volumes, notes, search language). */
  updateSeries: (
    key: string,
    changes: {
      display_name?: string;
      aliases?: string[];
      author?: string;
      total_volumes?: number;
      notes?: string;
      watch?: boolean;
      search_lang?: SeriesSearchLang;
    },
  ) =>
    request<SeriesSummary>(`/series/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    }),

  /** Add a library book to a series (sets book.series + book.volume). */
  addSeriesBook: (key: string, bookId: number, volume: string | null) =>
    request<SeriesSummary>(`/series/${encodeURIComponent(key)}/books`, {
      method: 'POST',
      body: JSON.stringify({ book_id: bookId, volume }),
    }),

  /** Remove a book from a series (clears its series + volume). */
  removeSeriesBook: (key: string, bookId: number) =>
    request<SeriesSummary>(`/series/${encodeURIComponent(key)}/books/${bookId}`, {
      method: 'DELETE',
    }),

  /** Change a member book's volume number within a series. */
  setSeriesBookVolume: (key: string, bookId: number, volume: string | null) =>
    request<SeriesSummary>(`/series/${encodeURIComponent(key)}/books/${bookId}`, {
      method: 'PATCH',
      body: JSON.stringify({ volume }),
    }),

  /** Rename a series on every member book (old name kept as an alias). */
  renameSeries: (key: string, name: string) =>
    request<SeriesSummary>(`/series/${encodeURIComponent(key)}/rename`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  /** Merge another series into this one. */
  mergeSeries: (key: string, otherKey: string) =>
    request<SeriesSummary>(`/series/${encodeURIComponent(key)}/merge`, {
      method: 'POST',
      body: JSON.stringify({ other_key: otherKey }),
    }),

  /**
   * Run the release lookup for one series. Pass `searchLang` to override the stored
   * language for this one-off check (the server also saves it); omit to use the
   * series' saved `search_lang`.
   */
  refreshSeries: (key: string, searchLang?: SeriesSearchLang) =>
    request<SeriesSummary>(`/series/${encodeURIComponent(key)}/refresh`, {
      method: 'POST',
      body: JSON.stringify(searchLang ? { search_lang: searchLang } : {}),
    }),

  checkSeries: () => request<{ checked: number; updated: number; series: string[] }>(
    '/series/check',
    { method: 'POST' },
  ),

  seriesAlerts: () => request<SeriesAlertsResponse>('/series/alerts'),

  /**
   * Mark Series-tab alerts as seen. Pass explicit keys, or {all:true} to dismiss every
   * currently-unseen alert. Returns the refreshed alert feed (with new seen state).
   */
  markAlertsSeen: (payload: { alert_keys?: string[]; all?: boolean }) =>
    request<SeriesAlertsResponse>('/series/alerts/seen', {
      method: 'POST',
      body: JSON.stringify({ alert_keys: payload.alert_keys ?? [], all: payload.all ?? false }),
    }),

  /** The current user's Series-tab preferences (active filter, optional sort). */
  getSeriesPreferences: () => request<SeriesPreferences>('/preferences/series'),

  /** Persist the current user's Series-tab preferences. */
  putSeriesPreferences: (prefs: SeriesPreferences) =>
    request<SeriesPreferences>('/preferences/series', {
      method: 'PUT',
      body: JSON.stringify(prefs),
    }),

  listExpected: () => request<ExpectedBook[]>('/series/expected'),

  addExpected: (input: ExpectedBookInput) =>
    request<ExpectedBook>('/series/expected', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  deleteExpected: (id: number) =>
    request<void>(`/series/expected/${id}`, { method: 'DELETE' }),

  // --- accounts, login (auth; docs/features/auth.md) ---

  /**
   * Who is logged in. `silent401` so the startup probe treats "not logged in"
   * as a normal answer instead of firing the global unauthorized handler.
   */
  me: () => request<AuthUser>('/auth/me', { silent401: true }),

  login: (email: string, password: string) =>
    request<AuthUser>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  /** Create an account (public). Logs the person in on success. 409 e-mail taken, 422 weak password. */
  register: (email: string, displayName: string, password: string) =>
    request<AuthUser>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, display_name: displayName, password }),
      silent401: true,
    }),

  /** Public login-screen settings: is self-registration on, minimum password length. */
  authConfig: () =>
    request<{ registration_enabled: boolean; password_min_length: number }>('/auth/config', {
      silent401: true,
    }),

  /** Change your own display name. */
  updateMe: (displayName: string) =>
    request<AuthUser>('/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ display_name: displayName }),
    }),

  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/auth/password', {
      method: 'POST',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),

  /** Resolve a setup/reset token to the person it is for (public). 410 when expired/used. */
  getSetupToken: (token: string) =>
    request<SetupTokenInfo>(`/auth/setup/${encodeURIComponent(token)}`, { silent401: true }),

  /** Set the password for a setup/reset token; logs the person in on success (public). */
  completeSetup: (token: string, password: string) =>
    request<AuthUser>('/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
      silent401: true,
    }),

  // --- admin: user management (admin only) ---

  listUsers: () => request<AdminUser[]>('/admin/users'),

  addUser: (email: string, displayName: string) =>
    request<CreatedUser>('/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email, display_name: displayName }),
    }),

  updateUser: (
    id: number,
    changes: { display_name?: string; disabled?: boolean; is_admin?: boolean },
  ) =>
    request<AdminUser>(`/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    }),

  newSetupLink: (id: number) =>
    request<SetupLink>(`/admin/users/${id}/setup-link`, { method: 'POST' }),
};
