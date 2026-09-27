/**
 * Type of the palette record vite.config.ts reads (the PWA manifest and the
 * theme-color meta tag). tailwind.config.js stays JavaScript, as Tailwind
 * loads it; this declaration lets the Vite config import it under `strict`
 * without `allowJs`.
 */
import type { Config } from 'tailwindcss';

declare const config: Config;
export default config;
