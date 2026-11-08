/// <reference types="vitest/config" />
// DEV/SCREENSHOT ONLY (wave 6). Mounts an in-memory mock of the series + auth API
// so the Series tab's release-watch UI can be screenshotted without a backend.
// Run with: `vite --config vite.series-mock.config.ts --port 5192`.
import react from '@vitejs/plugin-react';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vite';

function send(res: any, status: number, body?: unknown) {
  res.statusCode = status;
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// A realistic set of watched series exercising every release status + the Details body.
const SERIES = [
  {
    series_key: 'kings dark tidings',
    name: "King's Dark Tidings",
    author: 'Kel Kade',
    aliases: ['Kroniki Mroku'],
    owned_volumes: [],
    missing_volumes: [],
    owned_count: 6,
    read_count: 6,
    unread_owned_count: 0,
    total_known: 7,
    section: 'in_progress',
    started: true,
    finished: false,
    watch: true,
    next_expected: null,
    next_expected_pl: null,
    next_expected_en: null,
    checking: false,
    last_checked: '2026-02-01T00:00:00Z',
    notes: null,
    search_lang: 'both',
    release_summary: {
      status: 'in_translation',
      headline:
        'Fabryka Słów nie podała oficjalnej daty tomu 7 (Ritual of Ruin); tłumaczenie ruszyło na początku 2026.',
      next_title: 'Ritual of Ruin',
      next_volume: 7,
      expected_date: '2026',
      details: [
        { text: 'Wydawca potwierdził prace nad przekładem w styczniu 2026.', source_url: 'https://example.com/fs' },
        { text: 'Autor zapowiedział premierę EN na jesień 2025.', source_url: 'https://example.com/kade' },
      ],
      editions: {
        pl: { status: 'in_translation', title: 'Rytuał Ruin', date: null, source_url: 'https://example.com/pl' },
        en: { status: 'released', title: 'Ritual of Ruin', date: '2025-11-11', source_url: 'https://example.com/en' },
      },
      added_book_id: 312,
      checked_at: '2026-02-01T00:00:00Z',
    },
  },
  {
    series_key: 'the wandering inn',
    name: 'The Wandering Inn',
    author: 'pirateaba',
    aliases: [],
    owned_volumes: [],
    missing_volumes: [],
    owned_count: 10,
    read_count: 4,
    unread_owned_count: 6,
    total_known: 12,
    section: 'in_progress',
    started: true,
    finished: false,
    watch: true,
    next_expected: null,
    next_expected_pl: null,
    next_expected_en: null,
    checking: false,
    last_checked: '2026-01-20T00:00:00Z',
    notes: null,
    search_lang: 'en',
    release_summary: {
      status: 'announced',
      headline: 'Volume 11 announced for 2026; no exact date yet.',
      next_title: 'Volume 11',
      next_volume: 11,
      expected_date: '2026',
      details: [{ text: 'Author confirmed Volume 11 on Patreon.', source_url: 'https://example.com/twi' }],
      editions: {
        en: { status: 'announced', title: 'Volume 11', date: null, source_url: 'https://example.com/twi' },
      },
      added_book_id: null,
      checked_at: '2026-01-20T00:00:00Z',
    },
  },
  {
    series_key: 'the way of the shaman',
    name: 'The Way of the Shaman',
    author: 'Vasily Mahanenko',
    aliases: ['Droga Szamana'],
    owned_volumes: [],
    missing_volumes: [],
    owned_count: 8,
    read_count: 8,
    unread_owned_count: 0,
    total_known: 8,
    section: 'complete',
    started: true,
    finished: true,
    watch: true,
    next_expected: null,
    next_expected_pl: null,
    next_expected_en: null,
    checking: false,
    last_checked: '2026-02-05T00:00:00Z',
    notes: null,
    search_lang: 'pl',
    release_summary: {
      status: 'no_news',
      headline: 'Brak nowych informacji o kolejnym tomie.',
      next_title: null,
      next_volume: null,
      expected_date: null,
      details: [],
      editions: {},
      added_book_id: null,
      checked_at: '2026-02-05T00:00:00Z',
    },
  },
  {
    series_key: 'cradle',
    name: 'Cradle',
    author: 'Will Wight',
    aliases: [],
    owned_volumes: [],
    missing_volumes: [],
    owned_count: 12,
    read_count: 12,
    unread_owned_count: 0,
    total_known: 12,
    section: 'complete',
    started: true,
    finished: true,
    watch: true,
    next_expected: null,
    next_expected_pl: null,
    next_expected_en: null,
    checking: false,
    last_checked: null,
    notes: null,
    search_lang: 'pl',
    release_summary: null,
  },
];

const EXPECTED = [
  {
    id: 1,
    title: 'Ritual of Ruin',
    author: 'Kel Kade',
    series_key: 'kings dark tidings',
    series_name: "King's Dark Tidings",
    volume: '7',
    expected_date: '2026',
    source_url: 'https://example.com/en',
    source: 'goodreads',
    confidence: 'medium',
    notes: null,
  },
  {
    id: 2,
    title: 'Some Upcoming Standalone With A Rather Long Title To Test Wrapping',
    author: 'Anonymous',
    series_key: null,
    series_name: null,
    volume: null,
    expected_date: null,
    source_url: 'https://example.com/x',
    source: 'manual',
    confidence: null,
    notes: null,
  },
];

const PREFS = { filter: 'all', sort: null, default_search_lang: 'pl' };

function seriesMockPlugin(): Plugin {
  return {
    name: 'series-api-mock',
    configureServer(server) {
      server.middlewares.use('/api', (req: Connect.IncomingMessage, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (path === '/auth/me') {
          return send(res, 200, { id: 1, email: 'a@b.c', display_name: 'Patryk', is_admin: true });
        }
        if (path === '/books' && method === 'GET') return send(res, 200, []);
        if (path === '/series' && method === 'GET') return send(res, 200, SERIES);
        if (path === '/series/expected' && method === 'GET') return send(res, 200, EXPECTED);
        if (path === '/series/alerts' && method === 'GET') {
          return send(res, 200, { count: 0, unseen_count: 0, in_progress: [], new_volume: [] });
        }
        if (path === '/preferences/series') {
          return send(res, 200, PREFS);
        }
        // PATCH /series/{key}, POST /series/{key}/refresh → echo the first series.
        const refresh = path.match(/^\/series\/([^/]+)\/refresh$/);
        if (refresh && method === 'POST') return send(res, 200, SERIES[0]);
        const patch = path.match(/^\/series\/([^/]+)$/);
        if (patch && method === 'PATCH') return send(res, 200, SERIES[0]);

        return next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), seriesMockPlugin()],
  server: { host: '127.0.0.1', port: 5192, strictPort: true },
});
