import { Button } from 'primereact/button';
import { useCallback, useEffect, useState } from 'react';

import { useAgentAnchor, setStaticTabs, setActiveTab } from './agent-ui';
import { useAuth, UserMenu, UsersPage } from './auth';
import { ChatProvider, useChat } from './chat/ChatProvider';
import { ChatWidget, chatMicRegistry } from './components/ChatWidget';
import { GlobalMic, globalMicRegistry } from './components/GlobalMic';
import { Library } from './pages/Library';
import { Series } from './pages/Series';
import { Favourites } from './pages/Favourites';
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
import { applyTheme, initialTheme, THEME_KEY, type Theme } from './theme';

const PAGES: { id: UiTab; label: string; icon: string }[] = [
  { id: 'library', label: 'Library', icon: 'pi pi-book' },
  { id: 'series', label: 'Series', icon: 'pi pi-bookmark' },
  { id: 'favourites', label: 'Favourites', icon: 'pi pi-heart' },
  { id: 'stats', label: 'Statistics', icon: 'pi pi-chart-bar' },
  { id: 'ranking', label: 'Ranking', icon: 'pi pi-sort-amount-down' },
];

/**
 * The pages the shell can show. `users` is the admin-only account page; it is NOT
 * an agent tab (not in PAGES, not a static tab, no anchor) so the assistant can
 * never navigate to it or manage accounts.
 */
type AppPage = UiTab | 'users';

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
      <SettingAnchor
        id="settings.showVoiceButton"
        label="Show voice button"
        description="Show the floating microphone on the main view, next to the chat bubble, so the user can talk to the assistant without opening the chat."
        get={() => settings.showVoiceButton}
        settingKey="showVoiceButton"
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
  const [page, setPage] = useState<AppPage>('library');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { open: chatOpen, setOpen: setChatOpen, switchMode } = useChat();
  const { user } = useAuth();

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  // Central Ctrl+M routing (single owner, so no mic double-fires): when the chat
  // panel is open, toggle the chat mic; otherwise toggle the global mic on the
  // main view. Esc cancels whichever mic is recording. Neither MicButton owns
  // the shortcut (both pass captureShortcuts={false}).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        if (chatOpen) {
          chatMicRegistry.current?.toggle();
        } else if (globalMicRegistry.current) {
          globalMicRegistry.current.toggle();
        } else {
          // No global mic (setting off): fall back to opening the chat on the UI
          // agent so Ctrl+M still reaches a microphone.
          switchMode('ui');
          setChatOpen(true);
        }
      } else if (e.key === 'Escape') {
        if (chatMicRegistry.current?.isRecording()) {
          chatMicRegistry.current.cancel();
        } else if (globalMicRegistry.current?.isRecording()) {
          globalMicRegistry.current.cancel();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatOpen, setChatOpen, switchMode]);

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);

  // Seed the static tab list for the agent (so unmounted tabs are still described).
  useEffect(() => {
    setStaticTabs(PAGES.map((p) => ({ id: p.id, label: p.label })));
  }, []);

  // Keep the registry's active tab current. The admin `users` page is not an agent
  // tab, so report `library` while it is open rather than an unknown tab id.
  useEffect(() => {
    setActiveTab(page === 'users' ? 'library' : page);
  }, [page]);

  // --- app-global anchors -------------------------------------------------------------
  useAgentAnchor({
    id: 'nav.tab',
    kind: 'tab',
    label: 'Navigation tab',
    description: 'The active top-level tab. Invoke with action "navigate" and args { tab }.',
    actions: ['navigate'],
    // Never surface the admin-only `users` page to the agent: report a real agent
    // tab instead so account management stays outside the assistant's reach.
    getState: () => (page === 'users' ? 'library' : page),
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
          {/* Account lives in the bottom tab bar on phones only; the top-bar
              avatar covers it on wider screens. */}
          <span className="app-nav-account">
            <UserMenu variant="tab" active={page === 'users'} onOpenUsers={() => setPage('users')} />
          </span>
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
          {/* Desktop top-bar account control (hidden on phones). */}
          <span className="app-bar-account">
            <UserMenu variant="bar" onOpenUsers={() => setPage('users')} />
          </span>
        </div>
      </header>

      <main className="app-main">
        {page === 'library' && <Library />}
        {page === 'series' && <Series />}
        {page === 'favourites' && <Favourites />}
        {page === 'stats' && <Stats />}
        {page === 'ranking' && <Ranking />}
        {page === 'users' && user?.is_admin && <UsersPage />}
      </main>

      <SettingsSidebar visible={settingsOpen} onHide={() => setSettingsOpen(false)} />
      <ChatWidget />
      <GlobalMic />
    </>
  );
}

export default function App() {
  return (
    <SettingsProvider>
      <ChatProvider>
        <AppShell />
      </ChatProvider>
    </SettingsProvider>
  );
}
