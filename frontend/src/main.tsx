import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { PrimeReactProvider } from 'primereact/api';
import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { AuthGate, AuthProvider } from './auth';
import { CACHE_BUSTER, CACHE_MAX_AGE, createQueryClient, persister } from './queries';
import { applyTheme, initialTheme } from './theme';

// PrimeReact icons + flex utilities. The theme CSS is swapped at runtime (see theme.ts),
// so it is loaded there, not statically, to keep light/dark consistent across components.
import 'primeicons/primeicons.css';
import 'primeflex/primeflex.css';
import './index.css';

// Apply the stored (or default light) theme before first paint so the login and
// setup screens already carry the dashboard look and the PrimeReact theme CSS.
applyTheme(initialTheme());

// One QueryClient for the whole app. Its cache is persisted to IndexedDB so the last
// data shows immediately on a cold start and refreshes in the background (SWR).
const queryClient = createQueryClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: CACHE_MAX_AGE,
        // A new release changes the buster, so an older build's cache is discarded.
        buster: CACHE_BUSTER,
      }}
    >
      <PrimeReactProvider>
        <AuthProvider>
          <AuthGate>
            <App />
          </AuthGate>
        </AuthProvider>
      </PrimeReactProvider>
    </PersistQueryClientProvider>
  </React.StrictMode>,
);
