/**
 * Design colour tokens — the palette both stacks read.
 *
 * WHY here: `web/shared-ui/src/styles/theme.css` (`@theme`) is the single
 * source of truth for colour, and its TypeScript mirror served the browser.
 * Nothing outside the browser could reach it, so the three HTML e-mail
 * builders (notification, admin-api, alert-engine) and the edge SCADA page
 * each wrote their own palette: the brand blue was `#0066cc` in one and
 * `#3B82F6` in another, danger `#dc3545` beside `#DC2626` — a customer's
 * first sight of the product, in colours the product does not use
 * (FE-MEDIUM-093).
 *
 * The values live in this zero-dependency module so a NestJS service and the
 * browser read the same bytes. `theme.ts` re-exports them, so
 * `tests/invariants/web-theme-token-parity.spec.ts` still holds them equal to
 * `theme.css` — the CSS stays the SSoT, this is its one mirror.
 */
type Scale10 = Readonly<Record<50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900, string>>;

export interface ColorTokens {
  readonly primary: Scale10;
  readonly secondary: Scale10;
  readonly accent: Scale10;
  readonly neutral: Scale10;
  readonly success: Scale10;
  readonly warning: Scale10;
  readonly error: Scale10;
  readonly info: Scale10;
  readonly gray: Readonly<Record<400, string>>;
  readonly white: string;
  readonly black: string;
  readonly transparent: string;
}

// WHY `string` values, not `as const` literals: a token used as a default
// parameter or a `useState` initial value would otherwise pin that field to
// ONE hex literal type and reject every other token.
export const colors: ColorTokens = {
  /** Primary — Ocean Blue */
  primary: {
    50: '#e6f3ff',
    100: '#b3d9ff',
    200: '#80bfff',
    300: '#4da6ff',
    400: '#1a8cff',
    500: '#0073e6',
    600: '#005bb3',
    700: '#004280',
    800: '#002a4d',
    900: '#00111a',
  },

  /** Secondary — Sea Green */
  secondary: {
    50: '#e6fff5',
    100: '#b3ffe0',
    200: '#80ffcc',
    300: '#4dffb8',
    400: '#1affa3',
    500: '#00e68a',
    600: '#00b36b',
    700: '#00804d',
    800: '#004d2e',
    900: '#001a10',
  },

  /** Accent — Coral */
  accent: {
    50: '#fff5f2',
    100: '#ffe0d9',
    200: '#ffccc0',
    300: '#ffb8a6',
    400: '#ffa38d',
    500: '#ff8f73',
    600: '#cc7259',
    700: '#995540',
    800: '#663926',
    900: '#331c13',
  },

  /** Neutral — slate */
  neutral: {
    50: '#f8fafc',
    100: '#f1f5f9',
    200: '#e2e8f0',
    300: '#cbd5e1',
    400: '#94a3b8',
    500: '#64748b',
    600: '#475569',
    700: '#334155',
    800: '#1e293b',
    900: '#0f172a',
  },

  /** Semantic scales (50 / 100 / 500 / 600 / 700, as theme.css declares them) */
  success: {
    50: '#ecfdf5',
    100: '#d1fae5',
    200: '#a7f3d0',
    300: '#6ee7b7',
    400: '#34d399',
    500: '#10b981',
    600: '#059669',
    700: '#047857',
    800: '#065f46',
    900: '#064e3b',
  },
  warning: {
    50: '#fffbeb',
    100: '#fef3c7',
    200: '#fde68a',
    300: '#fcd34d',
    400: '#fbbf24',
    500: '#f59e0b',
    600: '#d97706',
    700: '#b45309',
    800: '#92400e',
    900: '#78350f',
  },
  error: {
    50: '#fef2f2',
    100: '#fee2e2',
    200: '#fecaca',
    300: '#fca5a5',
    400: '#f87171',
    500: '#ef4444',
    600: '#dc2626',
    700: '#b91c1c',
    800: '#991b1b',
    900: '#7f1d1d',
  },
  info: {
    50: '#eff6ff',
    100: '#dbeafe',
    200: '#bfdbfe',
    300: '#93c5fd',
    400: '#60a5fa',
    500: '#3b82f6',
    600: '#2563eb',
    700: '#1d4ed8',
    800: '#1e40af',
    900: '#1e3a8a',
  },

  /**
   * The one Tailwind default theme.css overrides: gray-400 darkened for WCAG
   * 2.1 AA text contrast (FE-MEDIUM-024). Also the axis/helper-text grey.
   */
  gray: {
    400: '#6b7280',
  },

  white: '#ffffff',
  black: '#000000',
  transparent: 'transparent',
};

/**
 * Ordered categorical palette for chart series (recharts, pies, gauges) and
 * for any list of things that needs one colour each: brand first, then the
 * semantic accents, then the deep brand shades.
 *
 * WHY here and not in the chart primitives: the admin analytics service picks
 * the colours for the charts it serves, and a printed report, a PDF export and
 * an e-mail summary all need the same order. One list, read by both stacks.
 */
export const chartPalette: readonly string[] = [
  colors.primary[500],
  colors.secondary[600],
  colors.accent[500],
  colors.warning[500],
  colors.info[600],
  colors.error[500],
  colors.primary[700],
  colors.accent[700],
];

/** Chart chrome shared by every chart: grid lines, axis strokes, tooltip borders. */
export const chartChrome: Readonly<{ grid: string; axis: string; border: string }> = {
  grid: colors.neutral[200],
  axis: colors.gray[400],
  border: colors.neutral[200],
};

/** The ten steps every semantic scale declares, in order. */
const SCALE_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

const SCALE_NAMES = [
  'primary',
  'secondary',
  'accent',
  'neutral',
  'success',
  'warning',
  'error',
  'info',
] as const;

/**
 * Every token as a flat `name -> hex` pair, in declaration order.
 *
 * WHY the module publishes its own enumeration: the surfaces that cannot
 * import it — the Rust edge gateway's SCADA page and its PWA manifest — are
 * generated from these tokens, and a generator walking the nested object has
 * to widen the numeric-keyed scales to `any` to do it. Enumerating here keeps
 * the generators typed and makes a new scale reach them by construction.
 *
 * `transparent` is left out: it is not a colour a generator can turn into
 * channels or a swatch.
 */
export const colorTokenEntries: ReadonlyArray<readonly [string, string]> = [
  ...SCALE_NAMES.flatMap((scale) =>
    SCALE_STEPS.map((step) => [`${scale}-${step}`, colors[scale][step]] as const),
  ),
  ['gray-400', colors.gray[400]] as const,
  ['white', colors.white] as const,
  ['black', colors.black] as const,
];
