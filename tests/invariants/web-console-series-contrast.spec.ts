/**
 * INVARIANT (FE-HIGH-333): a data series the console paints from its theme
 * scales stays that many series in every workspace and both themes.
 *
 * WHY: suderra.css paints `primary-*` in the workspace accent and `gray-*` in
 * graphite, and the Company workspace's accent is a near-neutral slate. A
 * series told apart by hue — "accent for at a post, graphite for away", the
 * hr-module crew locations — passes every render test and collapses on
 * screen in that workspace: offshore beside in transit and onshore beside on
 * leave measured 1.00–1.15:1, one swatch each in the rotation legend and the
 * split bar. Ramp names cannot catch it (`primary` and `gray` are different
 * names); only the resolved colours can. The measure is WCAG contrast, which
 * is lightness only: hue never counts as separation, so what stays apart
 * under the slate accent stays apart for a colour-blind reader in every
 * workspace too. Every series registered below is
 * resolved through theme.css and suderra.css (lib/web-console-theme.ts) for
 * aqua / gh / ctl / org × light / dark and held to:
 *
 *   - every pair of fills, and each fill against the card it is drawn on and
 *     its section tint, at least SERIES_MIN apart — four fills and the ground
 *     between paper and ink leave about 1.9:1 per step at best, and 1.4 keeps
 *     a pick near that ceiling and far from the collapsed 1.0–1.15;
 *   - the mark drawn on a fill (icon or label) at WCAG text contrast, 4.5:1;
 *   - the series' own icon on the card at the non-text 3:1;
 *   - no fill or mark on the alarm scales (warning, accent, error): Industry
 *     keeps amber and red for alarm and risk (README §7.8).
 *
 * A component that draws a categorical series from the scope registers its
 * tone table here.
 */
import { CREW_LOCATION_TONE } from '../../web/modules/hr-module/src/components/crew/crewLocationTone';
import {
  THEMES,
  WORKSPACES,
  type Theme,
  consoleColour,
  contrast,
  utilityFor,
} from './lib/web-console-theme';

const SERIES_MIN = 1.4;
const TEXT_MIN = 4.5;
const ICON_MIN = 3;

/** One series value's classes, as a tone table spells them. */
interface Tone {
  readonly fill: string;
  readonly onFill: string;
  readonly icon: string;
  readonly tint: string;
}

interface Series {
  readonly name: string;
  /** The card the series is drawn on. */
  readonly card: string;
  readonly tones: Readonly<Record<string, Tone>>;
}

const SERIES: readonly Series[] = [
  {
    // SeaLandSplitView's card and the rotation calendar's grid: bg-white dark:bg-gray-800.
    name: 'hr-module crew locations',
    card: 'bg-white dark:bg-gray-800',
    tones: CREW_LOCATION_TONE,
  },
];

const RISK_SCALE = /(?:^|[\s:])[a-z]+-(?:warning|accent|error)-\d/;

/** Every rule a series breaks in one theme and workspace — an empty list is the pass. */
function breaches(series: Series, theme: Theme, ws: string): string[] {
  const at = `${series.name} ${theme}/${ws}`;
  const card = consoleColour(utilityFor(series.card, 'bg', theme), theme, ws);
  const values = Object.entries(series.tones).map(([value, tone]) => ({
    value,
    tone,
    fill: consoleColour(utilityFor(tone.fill, 'bg', theme), theme, ws),
  }));
  const found: string[] = [];
  const check = (label: string, a: string, b: string, min: number): void => {
    const ratio = contrast(a, b);
    if (ratio < min) found.push(`${at} ${label}: ${a} vs ${b} = ${ratio.toFixed(2)} < ${min}`);
  };

  values.forEach((left, i) => {
    for (const right of values.slice(i + 1))
      check(`${left.value} fill vs ${right.value} fill`, left.fill, right.fill, SERIES_MIN);
  });
  for (const { value, tone, fill } of values) {
    const tint = consoleColour(utilityFor(tone.tint, 'bg', theme), theme, ws, card);
    check(`${value} fill vs card`, fill, card, SERIES_MIN);
    check(`${value} fill vs its tint`, fill, tint, SERIES_MIN);
    check(
      `${value} mark on fill`,
      consoleColour(utilityFor(tone.onFill, 'text', theme), theme, ws),
      fill,
      TEXT_MIN,
    );
    check(
      `${value} icon on card`,
      consoleColour(utilityFor(tone.icon, 'text', theme), theme, ws),
      card,
      ICON_MIN,
    );
    const risky = [tone.fill, tone.onFill, tone.icon, tone.tint].filter((classes) =>
      RISK_SCALE.test(classes),
    );
    if (risky.length > 0)
      found.push(`${at} ${value} paints from an alarm scale: ${risky.join(' | ')}`);
  }
  return found;
}

function allBreaches(series: Series): string[] {
  return THEMES.flatMap((theme) => WORKSPACES.flatMap((ws) => breaches(series, theme, ws)));
}

describe('INVARIANT (FE-HIGH-333): console data series stay distinct in every workspace and theme', () => {
  it.each(SERIES.map((series) => [series.name, series] as const))(
    '%s: fills apart, marks legible, no alarm scale',
    (_name, series) => {
      expect(Object.keys(series.tones).length).toBeGreaterThan(1);
      expect(allBreaches(series)).toEqual([]);
    },
  );

  describe('detects what it claims to', () => {
    // The crew tones before this gate: hue-coded, one step each, no dark variant.
    const HUE_CODED_TONES = {
      offshore: {
        fill: 'bg-primary-700',
        onFill: 'text-white',
        icon: 'text-primary-700 dark:text-primary-300',
        tint: 'bg-primary-50 dark:bg-primary-900/20',
      },
      onshore: {
        fill: 'bg-primary-300',
        onFill: 'text-primary-900',
        icon: 'text-primary-500 dark:text-primary-200',
        tint: 'bg-primary-50 dark:bg-primary-900/20',
      },
      transit: {
        fill: 'bg-gray-600',
        onFill: 'text-white',
        icon: 'text-gray-600 dark:text-gray-300',
        tint: 'bg-gray-50 dark:bg-gray-900/20',
      },
      leave: {
        fill: 'bg-gray-300',
        onFill: 'text-gray-900',
        icon: 'text-gray-400 dark:text-gray-500',
        tint: 'bg-gray-50 dark:bg-gray-900/20',
      },
    } satisfies Record<string, Tone>;
    const HUE_CODED: Series = {
      name: 'hue-coded crew',
      card: 'bg-white dark:bg-gray-800',
      tones: HUE_CODED_TONES,
    };

    it('flags the hue-coded pairs that collapse in the Company workspace', () => {
      const found = allBreaches(HUE_CODED);
      expect(found).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/light\/org offshore fill vs transit fill/),
          expect.stringMatching(/light\/org onshore fill vs leave fill/),
          expect.stringMatching(/dark\/org offshore fill vs transit fill/),
        ]),
      );
    });

    it('flags a series value painted on an alarm scale', () => {
      const amber: Series = {
        ...HUE_CODED,
        tones: {
          ...HUE_CODED_TONES,
          transit: { ...HUE_CODED_TONES.transit, fill: 'bg-warning-500' },
        },
      };
      expect(allBreaches(amber).some((row) => /transit paints from an alarm scale/.test(row))).toBe(
        true,
      );
    });

    it('resolves a scale the console scope does not re-map to an error, not a colour', () => {
      expect(() => consoleColour('bg-blue-600', 'light', 'aqua')).toThrow(/does not re-assign/);
    });
  });
});
