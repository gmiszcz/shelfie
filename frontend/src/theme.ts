// Theme bootstrap, shared by the app shell and the pre-login screens so the
// light dashboard look (and the PrimeReact theme CSS) is applied the moment the
// app loads — including on the login and setup screens, which render before the
// authenticated shell mounts.
//
// Vite: theme CSS as local URLs (no CDN), swapped at runtime via one <link>.
import darkThemeUrl from 'primereact/resources/themes/lara-dark-indigo/theme.css?url';
import lightThemeUrl from 'primereact/resources/themes/lara-light-indigo/theme.css?url';

export type Theme = 'dark' | 'light';

const THEME_HREF: Record<Theme, string> = {
  dark: darkThemeUrl,
  light: lightThemeUrl,
};

export const THEME_LINK_ID = 'primereact-theme';
export const THEME_KEY = 'shelfie.theme';

/** Set `data-theme` on <html> and point the single PrimeReact theme <link> at it. */
export function applyTheme(theme: Theme): void {
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

/** The stored theme, or light by default (the dashboard's default look). */
export function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch {
    // ignore
  }
  return 'light';
}
