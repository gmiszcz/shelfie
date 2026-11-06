import { Button } from 'primereact/button';
import { useEffect, useState } from 'react';

import { Library } from './pages/Library';

type Theme = 'dark' | 'light';

const THEME_HREF: Record<Theme, string> = {
  dark: 'https://unpkg.com/primereact@10.9.6/resources/themes/lara-dark-indigo/theme.css',
  light: 'https://unpkg.com/primereact@10.9.6/resources/themes/lara-light-indigo/theme.css',
};

const THEME_LINK_ID = 'primereact-theme';

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  let link = document.getElementById(THEME_LINK_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = THEME_LINK_ID;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  link.href = THEME_HREF[theme];
}

export default function App() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <>
      <header className="app-header">
        <h1>
          <i className="pi pi-book" style={{ color: 'var(--app-accent)' }} /> Shelfie
        </h1>
        <div className="spacer" />
        <Button
          icon={theme === 'dark' ? 'pi pi-sun' : 'pi pi-moon'}
          rounded
          text
          aria-label="Toggle theme"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        />
      </header>
      <main className="app-main">
        <Library />
      </main>
    </>
  );
}
