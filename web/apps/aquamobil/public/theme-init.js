/**
 * Theme + density pre-paint. MUST stay an EXTERNAL, same-origin script.
 *
 * WHY not inline: production nginx serves `script-src 'self'` with no
 * `'unsafe-inline'` (infrastructure/docker/nginx/snippets/security-headers.conf,
 * D14-SC-02). An inline <script> in index.html is therefore BLOCKED in
 * production — which silently pinned every user to the fallback theme and, worse,
 * left gloved workers on 50px controls instead of the 64px the density layer
 * promises. It failed only in production, only as a CSP console entry.
 *
 * Loaded with a plain blocking <script src> in <head> so it still runs before
 * first paint and there is no flash of the wrong theme.
 *
 * Keep in step with src/hooks/useTheme.ts and src/hooks/useDensity.ts: same
 * storage keys, same legacy-value migration, same DOM effects. The invariant
 * spec src/__tests__/design-token.invariant.spec.ts asserts they agree.
 */
(function () {
  var raw = null;
  var density = null;
  try {
    raw = localStorage.getItem('aquamobil_dark_mode');
    density = localStorage.getItem('aquamobil_touch_density');
  } catch (e) {
    // Private mode or blocked storage: fall through to defaults rather than
    // throwing before the app has rendered anything at all.
  }

  // Migrate the pre-v4 vocabulary so an upgrading install keeps its choice.
  if (raw === 'dark') raw = 'night';
  else if (raw === 'light') raw = 'day';

  var pref = raw === 'night' || raw === 'day' || raw === 'colour' ? raw : 'system';
  var theme =
    pref === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'night'
        : 'day'
      : pref;

  var root = document.documentElement;
  root.setAttribute('data-theme', theme);
  // Migration bridge: Konsta and not-yet-migrated pages still use `dark:`.
  root.classList.toggle('dark', theme === 'night' || theme === 'colour');
  root.setAttribute('data-density', density === 'glove' ? 'glove' : 'standard');

  var color = theme === 'day' ? '#f2f5f9' : theme === 'colour' ? '#0b2036' : '#0a1220';
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', color);
})();
