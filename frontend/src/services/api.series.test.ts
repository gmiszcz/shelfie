import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('series search-language API (wave 6)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('updateSeries PATCHes { search_lang } to the series endpoint', async () => {
    await api.updateSeries('the wandering inn', { search_lang: 'en' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/series/the%20wandering%20inn');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ search_lang: 'en' });
  });

  it('refreshSeries with a language POSTs { search_lang } as the body override', async () => {
    await api.refreshSeries('king s dark tidings', 'both');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/series/king%20s%20dark%20tidings/refresh');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ search_lang: 'both' });
  });

  it('refreshSeries without a language POSTs an empty body (use the stored language)', async () => {
    await api.refreshSeries('dune');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/series/dune/refresh');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
  });
});
