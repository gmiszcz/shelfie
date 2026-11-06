import { Button } from 'primereact/button';
import { TabMenu } from 'primereact/tabmenu';
import { useEffect, useState } from 'react';

import { ChatWidget } from './components/ChatWidget';
import { Library } from './pages/Library';
import { Ranking } from './pages/Ranking';
import { Stats } from './pages/Stats';

type Theme = 'dark' | 'light';
type Page = 'library' | 'stats' | 'ranking';

const THEME_HREF: Record<Theme, string> = {
  dark: 'https://unpkg.com/primereact@10.9.6/resources/themes/lara-dark-indigo/theme.css',
  light: 'https://unpkg.com/primereact@10.9.6/resources/themes/lara-light-indigo/theme.css',
};

const THEME_LINK_ID = 'primereact-theme';

const PAGES: { id: Page; label: string; icon: string }[] = [
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

export default function App() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [page, setPage] = useState<Page>('library');

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const activeIndex = PAGES.findIndex((p) => p.id === page);

  return (
    <>
      <header className="app-header">
        <h1>
          <i className="pi pi-book" style={{ color: 'var(--app-accent)' }} /> Shelfie
        </h1>
        <TabMenu
          className="app-nav"
          model={PAGES.map((p) => ({ label: p.label, icon: p.icon }))}
          activeIndex={activeIndex}
          onTabChange={(e) => setPage(PAGES[e.index].id)}
        />
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
        {page === 'library' && <Library />}
        {page === 'stats' && <Stats />}
        {page === 'ranking' && <Ranking />}
      </main>
      <ChatWidget />
    </>
  );
}
