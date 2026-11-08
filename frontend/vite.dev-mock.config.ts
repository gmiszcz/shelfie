/// <reference types="vitest/config" />
// DEV/TEST ONLY. This config is never imported by the app build (`vite build`
// uses vite.config.ts). It mounts an in-memory mock of the auth API so the
// login / setup / users screens can be driven and screenshotted without a
// backend. Run with: `vite --config vite.dev-mock.config.ts --port 5197`.
import react from '@vitejs/plugin-react';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vite';

interface MockUser {
  id: number;
  email: string;
  display_name: string;
  is_admin: boolean;
  disabled: boolean;
  has_password: boolean;
  created_at: string;
  book_count: number;
}

const users: MockUser[] = [
  {
    id: 1,
    email: 'patryk.batog@gmail.com',
    display_name: 'Patryk Batóg',
    is_admin: true,
    disabled: false,
    has_password: true,
    created_at: '2026-01-02T09:00:00Z',
    book_count: 1243,
  },
  {
    id: 2,
    email: 'ola@example.com',
    display_name: 'Ola Nowak',
    is_admin: false,
    disabled: false,
    has_password: false,
    created_at: '2026-10-21T12:30:00Z',
    book_count: 0,
  },
  {
    id: 3,
    email: 'tom@example.com',
    display_name: 'Tomasz Lewandowski',
    is_admin: false,
    disabled: true,
    has_password: true,
    created_at: '2026-06-15T08:15:00Z',
    book_count: 58,
  },
];

// A session flag driven by a query param so screenshots can force a state:
//   ?mockAuth=admin  → logged in as the admin (default)
//   ?mockAuth=out    → logged out (login screen)
// The client sends no such param; this is purely for the screenshot harness,
// which sets a cookie the middleware reads.

function readCookie(req: Connect.IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v ?? '');
  }
  return null;
}

function send(res: any, status: number, body?: unknown) {
  res.statusCode = status;
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function authMockPlugin(): Plugin {
  return {
    name: 'auth-api-mock',
    configureServer(server) {
      server.middlewares.use('/api', (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        const mode = readCookie(req, 'mockAuth') ?? 'admin';
        const admin = users[0];

        // --- auth ---
        if (path === '/auth/me') {
          if (mode === 'out') return send(res, 401, { detail: 'not logged in' });
          return send(res, 200, {
            id: admin.id,
            email: admin.email,
            display_name: admin.display_name,
            is_admin: admin.is_admin,
          });
        }
        if (path === '/auth/login' && req.method === 'POST') {
          return send(res, 200, {
            id: admin.id,
            email: admin.email,
            display_name: admin.display_name,
            is_admin: admin.is_admin,
          });
        }
        if (path === '/auth/logout') return send(res, 204);
        if (path === '/auth/password') return send(res, 204);

        // GET /auth/setup/{token}
        const setupMatch = path.match(/^\/auth\/setup\/(.+)$/);
        if (setupMatch && req.method === 'GET') {
          if (setupMatch[1] === 'expired') return send(res, 410, { detail: 'expired' });
          return send(res, 200, {
            email: 'ola@example.com',
            display_name: 'Ola Nowak',
            purpose: 'setup',
          });
        }
        if (path === '/auth/setup' && req.method === 'POST') {
          return send(res, 200, {
            id: 2,
            email: 'ola@example.com',
            display_name: 'Ola Nowak',
            is_admin: false,
          });
        }

        // --- library stubs (so the authed shell renders without errors) ---
        if (path === '/books' && req.method === 'GET') return send(res, 200, []);
        if (path === '/series' && req.method === 'GET') return send(res, 200, []);
        if (path === '/series/expected' && req.method === 'GET') return send(res, 200, []);
        if (path === '/series/alerts' && req.method === 'GET') {
          return send(res, 200, { alerts: [] });
        }

        // --- admin ---
        if (path === '/admin/users' && req.method === 'GET') {
          return send(res, 200, users);
        }
        if (path === '/admin/users' && req.method === 'POST') {
          const created: MockUser = {
            id: 4,
            email: 'nowa.osoba@example.com',
            display_name: 'Nowa Osoba',
            is_admin: false,
            disabled: false,
            has_password: false,
            created_at: new Date().toISOString(),
            book_count: 0,
          };
          return send(res, 201, {
            user: created,
            setup_url: 'https://shelfie.local/setup?token=demotoken1234567890',
            expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          });
        }
        const idMatch = path.match(/^\/admin\/users\/(\d+)$/);
        if (idMatch && req.method === 'PATCH') {
          return send(res, 200, users.find((u) => u.id === Number(idMatch[1])) ?? admin);
        }
        const linkMatch = path.match(/^\/admin\/users\/(\d+)\/setup-link$/);
        if (linkMatch && req.method === 'POST') {
          return send(res, 200, {
            setup_url: 'https://shelfie.local/setup?token=freshlink0987654321',
            expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          });
        }

        return next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), authMockPlugin()],
  server: { host: '127.0.0.1', port: 5197, strictPort: true },
});
