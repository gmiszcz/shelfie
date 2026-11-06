import type {
  Book,
  ReadingStatus,
  SearchResponse,
  VolumeSearchResult,
} from '../types';

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body = await resp.json();
      detail = body.detail ?? detail;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(resp.status, detail);
  }
  if (resp.status === 204) {
    return undefined as T;
  }
  return (await resp.json()) as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const api = {
  listBooks: () => request<Book[]>('/books'),

  getBook: (id: number) => request<Book>(`/books/${id}`),

  addBook: (volume: VolumeSearchResult, status: ReadingStatus = 'want') =>
    request<Book>('/books', {
      method: 'POST',
      body: JSON.stringify({ ...volume, status }),
    }),

  updateBook: (id: number, changes: { status?: ReadingStatus; stars?: number | null }) =>
    request<Book>(`/books/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    }),

  deleteBook: (id: number) => request<void>(`/books/${id}`, { method: 'DELETE' }),

  search: (q: string) => request<SearchResponse>(`/search?q=${encodeURIComponent(q)}`),
};
