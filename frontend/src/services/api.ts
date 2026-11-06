import type {
  Book,
  BookInput,
  BookPatch,
  GroupBy,
  RatingPair,
  RecomputeResult,
  SearchResponse,
  StatsResponse,
  VolumeSearchResult,
  Winner,
} from '../types';

const BASE = '/api';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
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
  return new ApiError(resp.status, detail);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!resp.ok) {
    throw await errorFrom(resp);
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
    const resp = await fetch(`${BASE}/covers`, { method: 'POST', body: form });
    if (!resp.ok) {
      throw await errorFrom(resp);
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
  nextPair: async (focus?: number): Promise<RatingPair | null> => {
    const query = focus != null ? `?focus=${focus}` : '';
    const pair = await request<RatingPair | undefined>(`/ratings/pair${query}`);
    return pair ?? null;
  },

  compare: (leftId: number, rightId: number, winner: Winner, sessionId = 'manual') =>
    request<RatingPair>('/ratings/compare', {
      method: 'POST',
      body: JSON.stringify({ left_id: leftId, right_id: rightId, winner, session_id: sessionId }),
    }),

  /** POST /api/agent/chat — the response body is an SSE stream; read it with chat/sse.ts. */
  chat: (message: string, sessionId: string | null, signal?: AbortSignal) =>
    fetch(`${BASE}/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ message, session_id: sessionId }),
      signal,
    }),

  resetChat: (sessionId: string) =>
    request<void>(`/agent/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
};
