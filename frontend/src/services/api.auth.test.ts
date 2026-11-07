import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api, onUnauthorized } from './api';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('api request contract', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends credentials same-origin and the X-Shelfie-Client header on every request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 1, email: 'a@b.c', display_name: 'A', is_admin: false }));
    await api.me();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['X-Shelfie-Client']).toBe('web');
  });

  it('adds the client header to state-changing POSTs (CSRF)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await api.logout();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/logout');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Shelfie-Client']).toBe('web');
  });

  it('notifies unauthorized listeners on a non-silent 401', async () => {
    const listener = vi.fn();
    const off = onUnauthorized(listener);
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'no' }, { status: 401 }));
    await expect(api.listBooks()).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('does NOT notify on the silent me() probe when logged out', async () => {
    const listener = vi.fn();
    const off = onUnauthorized(listener);
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'no' }, { status: 401 }));
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it('parses Retry-After into ApiError.retryAfter on a 429', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: 'slow down' }, { status: 429, headers: { 'Retry-After': '90' } }),
    );
    try {
      await api.login('a@b.c', 'secret');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(429);
      expect((err as ApiError).retryAfter).toBe(90);
    }
  });
});
