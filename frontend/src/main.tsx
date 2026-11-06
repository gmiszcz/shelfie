import { PrimeReactProvider } from 'primereact/api';
import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';

// PrimeReact icons + flex utilities. The theme CSS is swapped at runtime (see App.tsx),
// so it is loaded there, not statically, to keep light/dark consistent across components.
import 'primeicons/primeicons.css';
import 'primeflex/primeflex.css';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PrimeReactProvider>
      <App />
    </PrimeReactProvider>
  </React.StrictMode>,
);
