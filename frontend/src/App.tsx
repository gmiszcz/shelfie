import { Button } from 'primereact/button';
import { useEffect, useState } from 'react';

import { ChatWidget } from './components/ChatWidget';
import { Library } from './pages/Library';
import { Ranking } from './pages/Ranking';
import { SettingsProvider } from './settings/SettingsContext';
import { SettingsSidebar } from './settings/SettingsSidebar';
import { UI_BUS_EVENT, parseUiBusEvent } from './settings/uiBus';
import type { UiTab } from './settings/uiBus';
import { Stats } from './pages/Stats';

type Theme = 'dark' | 'light';

const THEME_HREF: Record<Theme, string> = {
  dark: 'https://unpkg.com/primereact@10.9.6/resources/themes/lara-dark-indigo/theme.css',
  light: 'https://unpkg.com/primereact@10.9.6/resources/themes/lara-light-indigo/theme.css',
};

const THEME_LINK_ID = 'primereact-theme';
const THEME_KEY = 'shelfie.theme';

const PAGES: { id: UiTab; label: string; icon: string }[] = [
  { id: 'library', label: 'Library', icon: 'pi pi-book' },
  { id: 'stats', label: 'Statistics', icon: 'pi pi-chart-bar' },
  { id: 'ranking', label: 'Ranking', icon: 'pi pi-sort-amount-down' },
];

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

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch {
    // ignore
  }
  return 'dark';
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [page, setPage] = useState<UiTab>('library');
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  // Agent UI bus (contract 3): switch to the right tab. The Library page
  // listens for the filter/open_book events itself; here we only make sure
  // the relevant tab is visible so the user sees the result.
  useEffect(() => {
    const onBus = (e: Event) => {
      const detail = parseUiBusEvent((e as CustomEvent).detail);
      if (!detail) {
        return;
      }
      if (detail.action === 'navigate') {
        setPage(detail.tab);
      } else if (
        detail.action === 'filter_library' ||
        detail.action === 'open_book' ||
        detail.action === 'clear_filter'
      ) {
        setPage('library');
      }
    };
    window.addEventListener(UI_BUS_EVENT, onBus as EventListener);
    return () => window.removeEventListener(UI_BUS_EVENT, onBus as EventListener);
  }, []);

  return (
    <SettingsProvider>
      <header className="app-bar">
        <div className="app-brand">
          <i className="pi pi-book" />
          <span>Shelfie</span>
        </div>

        <nav className="app-nav" aria-label="Primary">
          {PAGES.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`app-nav-item ${page === p.id ? 'active' : ''}`}
              aria-current={page === p.id ? 'page' : undefined}
              onClick={() => setPage(p.id)}
            >
              <i className={p.icon} />
              <span>{p.label}</span>
            </button>
          ))}
        </nav>

        <div className="app-bar-actions">
          <Button
            icon={theme === 'dark' ? 'pi pi-sun' : 'pi pi-moon'}
            rounded
            text
            aria-label="Toggle theme"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          />
          <Button
            icon="pi pi-cog"
            rounded
            text
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          />
        </div>
      </header>

      <main className="app-main">
        {page === 'library' && <Library />}
        {page === 'stats' && <Stats />}
        {page === 'ranking' && <Ranking />}
      </main>

      <SettingsSidebar visible={settingsOpen} onHide={() => setSettingsOpen(false)} />
      <ChatWidget />
    </SettingsProvider>
  );
}
