import { PrimeReactProvider } from 'primereact/api';
import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { AuthGate, AuthProvider } from './auth';
import { applyTheme, initialTheme } from './theme';

// PrimeReact icons + flex utilities. The theme CSS is swapped at runtime (see theme.ts),
// so it is loaded there, not statically, to keep light/dark consistent across components.
import 'primeicons/primeicons.css';
import 'primeflex/primeflex.css';
import './index.css';

// Apply the stored (or default light) theme before first paint so the login and
// setup screens already carry the dashboard look and the PrimeReact theme CSS.
applyTheme(initialTheme());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PrimeReactProvider>
      <AuthProvider>
        <AuthGate>
          <App />
        </AuthGate>
      </AuthProvider>
    </PrimeReactProvider>
  </React.StrictMode>,
);
