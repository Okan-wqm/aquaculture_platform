/**
 * Reef species — artwork and swimming character for the login scene.
 *
 * The artwork is eight hand-drawn SVG files (`art/*.svg`, facing right). Each
 * carries `.pitchg` (whole-body pitch), `.tailg` (caudal fin) and, where the
 * fish has one, `.pectg` (pectoral fin) groups that the swimmer rotates. The
 * colours are illustration, not interface: they live in the asset files, not
 * in this module, the same way the logo's do. Gradient ids are suffixed per
 * instance (`__ID__`) so two fish of a species never share a gradient.
 */
import baitSvg from './art/bait.svg?raw';
import bassSvg from './art/bass.svg?raw';
import breamSvg from './art/bream.svg?raw';
import mackerelSvg from './art/mackerel.svg?raw';
import salmonSvg from './art/salmon.svg?raw';
import troutSvg from './art/trout.svg?raw';
import tunaSvg from './art/tuna.svg?raw';
import turbotSvg from './art/turbot.svg?raw';

export type SpeciesKey = 'salmon' | 'bass' | 'bream' | 'trout' | 'mackerel' | 'turbot' | 'tuna';
export type PlaneKey = 'far' | 'mid' | 'near';

export interface SpeciesSpec {
  art: string;
  /** Height / width of the artwork */
  ar: number;
  baseW: number;
  /** Top speed, px/s at the near plane */
  vmax: number;
  /** Max heading change, rad/s */
  turn: number;
  /** Tail-beat amplitude, degrees */
  amp: number;
  /** Tail-beat frequency gain with speed */
  tailK: number;
  /** Depth band the fish keeps to */
  band: 'open' | 'upper' | 'bottom';
  /** Burst and coast durations, seconds */
  burst: readonly [number, number];
  coast: readonly [number, number];
  /** Coast speed as a fraction of vmax */
  coastFrac: number;
  /** Vertical bob, px/s */
  bob: number;
  pitchMax: number;
  /** Chance a new target is off-screen (default 0.24) */
  exitBias?: number;
}

export const SPECIES: Readonly<Record<SpeciesKey, SpeciesSpec>> = {
  salmon: {
    art: salmonSvg,
    ar: 72 / 200,
    baseW: 200,
    vmax: 85,
    turn: 1.3,
    amp: 9,
    tailK: 2.4,
    band: 'open',
    burst: [0.5, 1.2],
    coast: [1.4, 3.4],
    coastFrac: 0.24,
    bob: 6,
    pitchMax: 12,
  },
  bass: {
    art: bassSvg,
    ar: 62 / 190,
    baseW: 176,
    vmax: 72,
    turn: 1.9,
    amp: 10,
    tailK: 2.6,
    band: 'open',
    burst: [0.4, 0.9],
    coast: [0.9, 2.2],
    coastFrac: 0.3,
    bob: 6,
    pitchMax: 12,
  },
  bream: {
    art: breamSvg,
    ar: 94 / 152,
    baseW: 126,
    vmax: 46,
    turn: 1.7,
    amp: 7,
    tailK: 2.0,
    band: 'open',
    burst: [0.4, 0.8],
    coast: [2.2, 4.5],
    coastFrac: 0.12,
    bob: 10,
    pitchMax: 10,
  },
  trout: {
    art: troutSvg,
    ar: 64 / 190,
    baseW: 186,
    vmax: 92,
    turn: 1.5,
    amp: 9,
    tailK: 2.5,
    band: 'open',
    burst: [0.5, 1.1],
    coast: [1.2, 3.0],
    coastFrac: 0.26,
    bob: 6,
    pitchMax: 12,
  },
  mackerel: {
    art: mackerelSvg,
    ar: 42 / 176,
    baseW: 168,
    vmax: 108,
    turn: 1.6,
    amp: 6,
    tailK: 3.2,
    band: 'upper',
    burst: [1.2, 2.4],
    coast: [0.8, 1.6],
    coastFrac: 0.5,
    bob: 4,
    pitchMax: 8,
  },
  turbot: {
    art: turbotSvg,
    ar: 104 / 156,
    baseW: 118,
    vmax: 30,
    turn: 1.2,
    amp: 4.5,
    tailK: 1.2,
    band: 'bottom',
    burst: [0.6, 1.1],
    coast: [2.5, 5.5],
    coastFrac: 0.06,
    bob: 3,
    pitchMax: 4,
  },
  tuna: {
    art: tunaSvg,
    ar: 86 / 250,
    baseW: 250,
    vmax: 210,
    turn: 0.9,
    amp: 5,
    tailK: 3.4,
    band: 'open',
    burst: [1.6, 3.0],
    coast: [0.9, 1.8],
    coastFrac: 0.55,
    bob: 3,
    pitchMax: 7,
    exitBias: 0.7,
  },
};

/** Depth planes: scale and speed factor. */
export const PLANES: Readonly<Record<PlaneKey, number>> = { far: 0.5, mid: 0.74, near: 1 };

/** Roster per density: [species, plane]. */
export const ROSTERS: Readonly<
  Record<ReefDensity, ReadonlyArray<readonly [SpeciesKey, PlaneKey]>>
> = {
  low: [
    ['salmon', 'mid'],
    ['bass', 'far'],
    ['bream', 'mid'],
    ['trout', 'mid'],
    ['salmon', 'far'],
    ['turbot', 'near'],
    ['tuna', 'far'],
  ],
  med: [
    ['salmon', 'mid'],
    ['bass', 'far'],
    ['bream', 'mid'],
    ['trout', 'mid'],
    ['salmon', 'far'],
    ['turbot', 'near'],
    ['bass', 'near'],
    ['mackerel', 'mid'],
    ['mackerel', 'mid'],
    ['trout', 'near'],
    ['bream', 'far'],
    ['tuna', 'mid'],
  ],
  high: [
    ['salmon', 'mid'],
    ['bass', 'far'],
    ['bream', 'mid'],
    ['trout', 'mid'],
    ['salmon', 'far'],
    ['turbot', 'near'],
    ['bass', 'near'],
    ['mackerel', 'mid'],
    ['mackerel', 'mid'],
    ['trout', 'near'],
    ['bream', 'far'],
    ['salmon', 'near'],
    ['bass', 'mid'],
    ['mackerel', 'far'],
    ['trout', 'far'],
    ['turbot', 'mid'],
    ['salmon', 'far'],
    ['tuna', 'near'],
    ['tuna', 'mid'],
    ['tuna', 'far'],
  ],
};

/** Baitfish school size per density. */
export const SCHOOL_SIZE: Readonly<Record<ReefDensity, number>> = { low: 10, med: 14, high: 20 };

export type ReefDensity = 'low' | 'med' | 'high';

export function isReefDensity(value: string | null): value is ReefDensity {
  return value === 'low' || value === 'med' || value === 'high';
}

/** The artwork with its gradient ids made unique to one instance. */
export function speciesArt(art: string, uid: number): string {
  return art.split('__ID__').join(String(uid));
}

export const BAIT_ART = baitSvg;
