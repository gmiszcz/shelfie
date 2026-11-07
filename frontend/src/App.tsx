import { Button } from 'primereact/button';
import { useCallback, useEffect, useState } from 'react';

import { useAgentAnchor, setStaticTabs, setActiveTab } from './agent-ui';
import { ChatWidget } from './components/ChatWidget';
import { Library } from './pages/Library';
import { Ranking } from './pages/Ranking';
import { SettingsProvider, useSettings } from './settings/SettingsContext';
import { SettingsSidebar } from './settings/SettingsSidebar';
import {
  CARD_FIELDS,
  CARD_FIELD_LABELS,
  DETAIL_SECTIONS,
  DETAIL_SECTION_LABELS,
} from './settings/settingsTypes';
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
 * Register one display-setting toggle as an agent anchor. A tiny component so
 * each `useAgentAnchor` call sits at a component's top level (rules-of-hooks),
 * even though the settings list is iterated.
 */
function SettingAnchor({
  id,
  label,
  description,
  get,
  settingKey,
}: {
  id: string;
  label: string;
  description: string;
  get: () => boolean;
  settingKey: string;
}) {
  const { setSettingByKey } = useSettings();
  useAgentAnchor({
    id,
    kind: 'toggle',
    label,
    description,
    getState: get,
    set: (v) => {
      setSettingByKey(settingKey, Boolean(v));
    },
  });
  return null;
}

/**
 * Mount the display-settings anchors (one per card field / detail section plus
 * `showAllDetails`) so the agent can toggle any of them — whether or not the
 * settings sidebar is open. Rendered once at the shell level.
 */
function SettingsAnchors() {
  const { settings } = useSettings();
  return (
    <>
      {CARD_FIELDS.map((field) => (
        <SettingAnchor
          key={`card-${field}`}
          id={`settings.cardFields.${field}`}
          label={`Card field: ${CARD_FIELD_LABELS[field]}`}
          description={`Show the "${CARD_FIELD_LABELS[field]}" field on library book cards.`}
          get={() => settings.cardFields[field]}
          settingKey={field}
        />
      ))}
      {DETAIL_SECTIONS.map((section) => (
        <SettingAnchor
          key={`detail-${section}`}
          id={`settings.detailSections.${section}`}
          label={`Detail section: ${DETAIL_SECTION_LABELS[section]}`}
          description={`Show the "${DETAIL_SECTION_LABELS[section]}" section in the book detail dialog.`}
          get={() => settings.detailSections[section]}
          settingKey={section}
        />
      ))}
      <SettingAnchor
        id="settings.showAllDetails"
        label="Show all details by default"
        description="Expand the extended detail sections whenever a book is opened."
        get={() => settings.showAllDetails}
        settingKey="showAllDetails"
      />
    </>
  );
}

/**
 * The application shell. Lives inside `SettingsProvider`. It owns the active tab,
 * theme and settings-sidebar visibility, and registers the app-global agent
 * anchors (nav tab, theme toggle, settings sidebar) plus the per-setting toggles.
 * No agent-specific UI-bus listener remains: controls are driven through their
 * anchors.
 */
function AppShell() {
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

  // Seed the static tab list for the agent (so unmounted tabs are still described).
  useEffect(() => {
    setStaticTabs(PAGES.map((p) => ({ id: p.id, label: p.label })));
  }, []);

  // Keep the registry's active tab current.
  useEffect(() => {
    setActiveTab(page);
  }, [page]);

  // --- app-global anchors -------------------------------------------------------------
  useAgentAnchor({
    id: 'nav.tab',
    kind: 'tab',
    label: 'Navigation tab',
    description: 'The active top-level tab. Invoke with action "navigate" and args { tab }.',
    actions: ['navigate'],
    getState: () => page,
    invoke: (_action, args) => {
      const tab = args?.tab;
      if (tab === 'library' || tab === 'stats' || tab === 'ranking') {
        setPage(tab);
      }
    },
  });

  useAgentAnchor({
    id: 'theme.toggle',
    kind: 'select',
    label: 'Theme',
    description: 'The colour theme. Set to "dark" or "light".',
    getState: () => theme,
    options: () => [
      { value: 'dark', label: 'Dark' },
      { value: 'light', label: 'Light' },
    ],
    set: (v) => {
      const next = v === 'light' ? 'light' : 'dark';
      setTheme(next);
    },
  });

  useAgentAnchor({
    id: 'settings.sidebar',
    kind: 'dialog',
    label: 'Settings sidebar',
    description: 'The display-settings panel. Invoke with action "open" or "close".',
    actions: ['open', 'close'],
    getState: () => (settingsOpen ? 'open' : 'closed'),
    invoke: (action) => setSettingsOpen(action !== 'close'),
  });

  return (
    <>
      <SettingsAnchors />
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
