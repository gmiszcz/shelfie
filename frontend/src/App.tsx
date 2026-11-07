import { Button } from 'primereact/button';
import { useCallback, useEffect, useState } from 'react';

import { ChatWidget } from './components/ChatWidget';
import { Library } from './pages/Library';
import { Series } from './pages/Series';
import { Favourites } from './pages/Favourites';
import { Ranking } from './pages/Ranking';
import { SettingsProvider, useSettings } from './settings/SettingsContext';
import { SettingsSidebar } from './settings/SettingsSidebar';
import { UI_BUS_EVENT, dispatchUiAck, parseUiBusEvent } from './settings/uiBus';
import type { UiTab } from './settings/uiBus';
import { Stats } from './pages/Stats';
// Vite: theme CSS as local URLs (no CDN), swapped at runtime via one <link>.
import darkThemeUrl from 'primereact/resources/themes/lara-dark-indigo/theme.css?url';
import lightThemeUrl from 'primereact/resources/themes/lara-light-indigo/theme.css?url';

type Theme = 'dark' | 'light';

const THEME_HREF: Record<Theme, string> = {
  dark: darkThemeUrl,
  light: lightThemeUrl,
};

const THEME_LINK_ID = 'primereact-theme';
const THEME_KEY = 'shelfie.theme';

const PAGES: { id: UiTab; label: string; icon: string }[] = [
  { id: 'library', label: 'Library', icon: 'pi pi-book' },
  { id: 'series', label: 'Series', icon: 'pi pi-bookmark' },
  { id: 'favourites', label: 'Favourites', icon: 'pi pi-heart' },
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

/**
 * The application shell. Lives inside `SettingsProvider` so the agent UI bus
 * handler can toggle settings (`set_setting`). It owns the active tab, theme
 * and settings-sidebar visibility, listens for the App-level bus actions, and
 * keeps the `tab` / `openDialog` fields of `window.__shelfieUiState` current.
 */
function AppShell() {
  const { setSettingByKey } = useSettings();
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

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);

  // Agent UI bus (contract v2): App-level actions. Library owns the
  // filter/search/add-book/open_book actions and acks them itself; here we
  // handle navigation, settings sidebar, theme and set_setting.
  useEffect(() => {
    const onBus = (e: Event) => {
      const detail = parseUiBusEvent((e as CustomEvent).detail);
      if (!detail) {
        return;
      }
      switch (detail.action) {
        case 'navigate':
          setPage(detail.tab);
          dispatchUiAck({ action: 'navigate', ok: true });
          break;
        case 'filter_library':
        case 'open_book':
        case 'clear_filter':
        case 'set_search':
        case 'set_star_filter':
          // Library handles + acks these; ensure the library tab is visible.
          setPage('library');
          break;
        case 'open_settings':
          setSettingsOpen(true);
          dispatchUiAck({ action: 'open_settings', ok: true });
          break;
        case 'close_dialogs':
          setSettingsOpen(false);
          // Library also closes its dialogs and acks.
          break;
        case 'toggle_theme':
          toggleTheme();
          dispatchUiAck({ action: 'toggle_theme', ok: true });
          break;
        case 'set_setting': {
          const ok = setSettingByKey(detail.key, detail.value);
          dispatchUiAck({
            action: 'set_setting',
            ok,
            info: ok ? undefined : `unknown setting key "${detail.key}"`,
          });
          break;
        }
        case 'ranking':
          // Navigate to ranking; the ranking page owns its own search box.
          setPage('ranking');
          dispatchUiAck({ action: 'ranking', ok: true });
          break;
        default:
          break;
      }
    };
    window.addEventListener(UI_BUS_EVENT, onBus as EventListener);
    return () => window.removeEventListener(UI_BUS_EVENT, onBus as EventListener);
  }, [setSettingByKey, toggleTheme]);

  // Keep the tab and settings-dialog fields of the shared snapshot current.
  useEffect(() => {
    const prev = window.__shelfieUiState;
    window.__shelfieUiState = {
      tab: page,
      search: prev?.search ?? '',
      starFilter: prev?.starFilter ?? null,
      assistantFilter: prev?.assistantFilter ?? null,
      settings: prev?.settings ?? null,
      visibleBookIds: prev?.visibleBookIds ?? [],
      openDialog: settingsOpen ? 'settings' : (prev?.openDialog ?? 'none'),
    };
  }, [page, settingsOpen]);

  return (
    <>
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
            onClick={toggleTheme}
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
        {page === 'series' && <Series />}
        {page === 'favourites' && <Favourites />}
        {page === 'stats' && <Stats />}
        {page === 'ranking' && <Ranking />}
      </main>

      <SettingsSidebar visible={settingsOpen} onHide={() => setSettingsOpen(false)} />
      <ChatWidget />
    </>
  );
}

export default function App() {
  return (
    <SettingsProvider>
      <AppShell />
    </SettingsProvider>
  );
}
