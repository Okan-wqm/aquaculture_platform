/**
 * How each box kind and link kind is painted — the design document's KIND
 * table and its four path layers, as theme-token classes. SVG geometry
 * (stroke width, dash pattern) stays an attribute; every colour is a
 * `fill-*` / `stroke-*` utility on a theme scale, so the diagrams follow the
 * console's light and dark themes with no colour literal.
 */
import type { BoxKind, LinkKind } from './types';

/** A box's paper: the page background, so lines passing under it are hidden */
export const BOX_PAPER = 'fill-white dark:fill-gray-900';

export interface FrameStyle {
  readonly stroke: string;
  /** A tinted kind's own fill; the others are drawn on BOX_PAPER */
  readonly fill?: string;
  readonly strokeWidth: number;
  readonly dash?: string;
}

const INK = 'stroke-gray-700 dark:stroke-gray-300';
const STRONG_INK = 'stroke-gray-900 dark:stroke-gray-100';
const AMBER = 'stroke-warning-600 dark:stroke-warning-400';

export const BOX_FRAME: Readonly<Record<BoxKind, FrameStyle>> = {
  // a place in the facility tree
  place: { stroke: INK, strokeWidth: 1.5 },
  // a physical asset: drawn with an inner second rule (see BoxFrame)
  asset: { stroke: INK, strokeWidth: 1.5 },
  data: { stroke: 'stroke-primary-500', strokeWidth: 1.5 },
  // people and organisation: a heavy top rule (see BoxFrame)
  org: { stroke: INK, strokeWidth: 1.5 },
  assign: { stroke: INK, strokeWidth: 2, dash: '2 3' },
  // a calculation: an offset shadow (see BoxFrame)
  calc: { stroke: STRONG_INK, strokeWidth: 1.5 },
  // points to another section
  ext: { stroke: 'stroke-gray-500 dark:stroke-gray-400', strokeWidth: 1.5, dash: '6 4' },
  hub: { stroke: STRONG_INK, strokeWidth: 3 },
  warn: { stroke: AMBER, fill: 'fill-warning-100 dark:fill-warning-900', strokeWidth: 1.5 },
  // hatched amber: a locked stretch on the batch timeline
  hatch: { stroke: AMBER, strokeWidth: 1.5, dash: '6 4' },
};

/** The calc kind's offset shadow */
export const CALC_SHADOW = 'fill-gray-300 dark:fill-gray-600';
/** The asset kind's inner rule */
export const ASSET_INNER_RULE = 'stroke-gray-500 dark:stroke-gray-400';
/** The org kind's heavy top rule */
export const ORG_TOP_RULE = 'fill-gray-700 dark:fill-gray-300';
/** The hatch kind's stripe */
export const HATCH_STRIPE = 'fill-warning-300/60 dark:fill-warning-600/60';

export interface LinkStyle {
  readonly line: string;
  readonly head: string;
  readonly strokeWidth: number;
  readonly dash?: string;
  readonly roundCaps?: boolean;
}

export const LINK_STYLE: Readonly<Record<LinkKind, LinkStyle>> = {
  // is linked to
  solid: { line: INK, head: 'fill-gray-700 dark:fill-gray-300', strokeWidth: 1.75 },
  // assignment
  assign: {
    line: INK,
    head: 'fill-gray-700 dark:fill-gray-300',
    strokeWidth: 2,
    dash: '1.5 4.5',
    roundCaps: true,
  },
  // data flow
  data: { line: 'stroke-primary-500', head: 'fill-primary-500', strokeWidth: 2, dash: '7 5' },
  // setting and command
  ctrl: {
    line: 'stroke-primary-700 dark:stroke-primary-300',
    head: 'fill-primary-700 dark:fill-primary-300',
    strokeWidth: 1.5,
    dash: '2 3',
  },
};

/** A link label's text colour, by the kind of link it names */
export const LABEL_TEXT: Readonly<Record<LinkKind, string>> = {
  solid: 'text-gray-800 dark:text-gray-200',
  assign: 'text-gray-700 dark:text-gray-300',
  data: 'text-primary-800 dark:text-primary-200',
  ctrl: 'text-primary-800 dark:text-primary-200',
};
