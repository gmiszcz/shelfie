/// <reference types="vite/client" />

/**
 * The frontend package.json version, injected by Vite's `define` (see vite.config.ts).
 * Used as the React Query persist-cache buster so a new release drops the old cache.
 */
declare const __APP_VERSION__: string;
