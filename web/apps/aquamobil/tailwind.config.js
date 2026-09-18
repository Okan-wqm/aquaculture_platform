/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    // ── BREAKPOINT STRATEGY ────────────────────────────────────────────────
    // Read this before adding a responsive prefix. The app had NO breakpoints
    // at all until the tablet control board; these two are the whole ladder.
    //
    // THERE ARE EXACTLY TWO DEVICE CLASSES, and neither is a laptop:
    //   • a phone held in one hand at the pen — 360–430px wide in portrait,
    //     and 640–932px wide but only 350–430px TALL in landscape;
    //   • a tablet in the site cabin, wall-mounted or on a desk — 1024–1366px
    //     wide in landscape, 744–1024px in portrait.
    //
    // THE THRESHOLD IS TWO-DIMENSIONAL: (min-width: 900px) AND (min-height: 600px).
    //
    // WHY the height term is load-bearing and not decoration: the widest phone
    // in landscape (iPhone 16 Pro Max, 932×430) is WIDER than any width-only
    // threshold that tablets can still clear. A `min-width` breakpoint alone
    // therefore hands the three-column board to a phone lying on its side with
    // 430px of vertical room — three ~300px columns, none of them usable, on
    // the device the handheld layout was designed for. Height separates them
    // cleanly: every tablet in landscape is ≥744px tall, every phone in
    // landscape ≤430px. So A PHONE IN LANDSCAPE ALWAYS GETS THE HANDHELD SHELL.
    //
    // WHY 900px and not 768px: 768–834px is iPad portrait. Three columns there
    // are ~250px each — the unit grid and the detail pane both unreadable — so
    // a portrait tablet is better served by the handheld layout at full width.
    // 900px sits above every phone-portrait width and below every
    // tablet-landscape width (smallest ≈1024), leaving room for browser chrome
    // and split view. 12.9" iPad portrait (1024×1366) clears it and gets the
    // board, which is correct: it has the width for three columns.
    //
    // WHY `raw` queries instead of ordinary min-width breakpoints: a Tailwind
    // screen key cannot express the AND-height term any other way, and `raw`
    // keeps ONE query string that both the CSS prefix and the JS switch use.
    // The strings here are mirrored in src/hooks/useViewport.ts and held
    // identical by src/layouts/__tests__/board-breakpoint.spec.ts — a second,
    // different number living in CSS is exactly the drift that gate prevents.
    //
    // WHY the defaults (sm/md/lg/xl/2xl) are REPLACED rather than extended:
    // they encode a desktop ladder this app has no case for. Deleting them
    // makes an accidental laptop breakpoint impossible instead of merely
    // discouraged — Tier 1 rather than Tier 4.
    //
    // WHICH MECHANISM TO USE. The PRIMARY switch is JS (useIsBoardViewport →
    // src/layouts/AppShell.tsx), because phone and board are different
    // COMPONENT TREES — different chrome, different navigation, different hooks
    // mounted — not one tree with different padding. A CSS-only branch would
    // mount both, double every query and socket, and leave the hidden one in
    // the accessibility tree. These prefixes are for refinements INSIDE the
    // board (e.g. `board-wide:` widening the grid), where the tree is already
    // chosen and only the proportions change.
    screens: {
      board: { raw: '(min-width: 900px) and (min-height: 600px)' },
      'board-wide': { raw: '(min-width: 1280px) and (min-height: 600px)' },
    },
    extend: {
      fontFamily: {
        // v4 design typeface. Geist is self-hosted (src/styles/tokens.css) —
        // an offline-first PWA cannot depend on a font CDN.
        sans: ['Geist', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Geist', 'system-ui', 'sans-serif'],
        // Hero numerals, codes, timestamps — "uppercase survives only where a
        // machine speaks", and machine values are set in mono.
        mono: ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      // v4 type scale. WHY named steps instead of arbitrary `text-[13px]`:
      // arbitrary sizes are unreviewable and drift per page. These eight steps
      // are the whole vocabulary — anything outside them is a design bug.
      // The two sub-12px steps are held to the sunlight-readability ratchet in
      // src/__tests__/field-ergonomics.invariant.spec.ts, which counts them
      // alongside the arbitrary forms so renaming cannot bypass the floor.
      fontSize: {
        micro: ['10px', { lineHeight: '1' }],
        caption: ['11px', { lineHeight: '1' }],
        meta: ['12px', { lineHeight: '1.4' }],
        body: ['13px', { lineHeight: '1.5' }],
        title: ['15px', { lineHeight: '1.35', letterSpacing: '-0.005em' }],
        head: ['19px', { lineHeight: '1.2', letterSpacing: '-0.015em' }],
        display: ['26px', { lineHeight: '1.15', letterSpacing: '-0.025em' }],
        hero: ['46px', { lineHeight: '1', letterSpacing: '-0.035em' }],
      },
      colors: {
        // ── v4 semantic tokens (src/styles/tokens.css) ────────────────────
        // These resolve per theme at runtime, so a component writes ONE class
        // and night/day/colour all come out right. Prefer these over the
        // legacy palettes below in all new and migrated code.
        surface: {
          0: 'var(--bg-solid)',
          1: 'var(--s1)',
          2: 'var(--s2)',
          3: 'var(--s3)',
        },
        ink: {
          1: 'var(--ink1)',
          2: 'var(--ink2)',
          3: 'var(--ink3)',
        },
        line: {
          DEFAULT: 'var(--line)',
          strong: 'var(--line2)',
        },
        acc: {
          DEFAULT: 'var(--acc)',
          on: 'var(--on-acc)',
          dim: 'var(--acc-dim)',
        },
        warn: {
          DEFAULT: 'var(--warn)',
          dim: 'var(--warn-dim)',
        },
        crit: {
          DEFAULT: 'var(--crit)',
          dim: 'var(--crit-dim)',
        },
        ok: 'var(--ok)',
        dock: 'var(--dock)',
        // Per-log-type colour coding (feed/mort/water/cull/move/harvest).
        type: {
          feeding: 'var(--type-feeding)',
          'feeding-dim': 'var(--type-feeding-dim)',
          mortality: 'var(--type-mortality)',
          'mortality-dim': 'var(--type-mortality-dim)',
          water: 'var(--type-water)',
          'water-dim': 'var(--type-water-dim)',
          cull: 'var(--type-cull)',
          'cull-dim': 'var(--type-cull-dim)',
          transfer: 'var(--type-transfer)',
          'transfer-dim': 'var(--type-transfer-dim)',
          harvest: 'var(--type-harvest)',
          'harvest-dim': 'var(--type-harvest-dim)',
        },
      },
      boxShadow: {
        // v4: one theme-aware elevation. Cards sit above the ground with a real
        // shadow rather than a border, which is what makes the surface read as
        // layered instead of outlined.
        token: 'var(--shadow)',
        // The accent's own halo, for the primary CTA and the raised scan button.
        // Kept as a token so it tracks the theme instead of freezing one teal.
        acc: '0 10px 24px var(--acc-dim)',
        // These two are the whole set on purpose. The pre-v4 config also declared
        // card/card-hover/elevated and a family of coloured glows, all with frozen
        // rgba() that could not follow a theme; every one of them ended at zero
        // usages once the token system landed, so they are gone rather than left
        // as an invitation to reintroduce a hard-coded shadow.
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.25rem',
      },
      // v4 motion. "Pages slide up on a spring curve, the sheet springs from the
      // dock, holds fill, checks pop. Nothing just appears." Spring curves rather
      // than ease-out are what separate this from a stock Material transition.
      // Honoured only when the user has not asked for reduced motion — see the
      // prefers-reduced-motion block in src/styles/main.css.
      keyframes: {
        'am-page': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'am-up': {
          from: { transform: 'translateY(102%)' },
          to: { transform: 'none' },
        },
        'am-fade': { from: { opacity: '0' }, to: { opacity: '1' } },
        'am-blip': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.25' },
        },
        'am-pop': {
          '0%': { transform: 'scale(0.6)', opacity: '0' },
          '60%': { transform: 'scale(1.06)' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        'am-sweep': {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(300%)' },
        },
        'am-scan': {
          '0%, 100%': { top: '6%' },
          '50%': { top: '86%' },
        },
      },
      animation: {
        'am-page': 'am-page 0.32s cubic-bezier(0.2, 0.8, 0.2, 1) both',
        'am-up': 'am-up 0.34s cubic-bezier(0.22, 1, 0.36, 1) both',
        'am-fade': 'am-fade 0.2s ease-out both',
        'am-blip': 'am-blip 2.4s ease-in-out infinite',
        'am-pop': 'am-pop 0.35s cubic-bezier(0.2, 0.8, 0.2, 1) both',
        'am-sweep': 'am-sweep 1.6s ease-in-out infinite',
        'am-scan': 'am-scan 2.8s ease-in-out infinite',
      },
      // Safe area for iPhone notch
      spacing: {
        safe: 'env(safe-area-inset-bottom)',
        'safe-top': 'env(safe-area-inset-top)',
        'safe-left': 'env(safe-area-inset-left)',
        'safe-right': 'env(safe-area-inset-right)',
        // MOB-MEDIUM-009: the 44px gloved-use touch-target floor. Interactive
        // elements use `min-h-touch min-w-touch` — enforced by
        // src/__tests__/field-ergonomics.invariant.spec.ts.
        touch: '2.75rem',
        // v4 density scale — control heights that grow when the worker turns on
        // Gloves in Account (`<html data-density="glove">`). These sit ABOVE the
        // 44px floor above; they never replace it. Values in src/styles/tokens.css.
        'tap-check': 'var(--tap-check)',
        'tap-logbtn': 'var(--tap-logbtn)',
        'tap-quick': 'var(--tap-quick)',
        'tap-chip': 'var(--tap-chip)',
        'tap-tile': 'var(--tap-tile)',
        'tap-add': 'var(--tap-add)',
        'tap-pill': 'var(--tap-pill)',
        'tap-key': 'var(--tap-key)',
        'tap-save': 'var(--tap-save)',
      },
    },
  },
  plugins: [],
};
