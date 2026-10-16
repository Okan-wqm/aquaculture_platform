/**
 * Builders for the architecture diagrams' content — the design document's
 * `bx` / `ln` / `grp` helpers, typed. WHY builders and not object literals:
 * every box and link carries the same defaults (a 170 × 96 place box; a solid
 * link from the source's right side to the target's left side, both at their
 * middle), so the defaults live here once and a section lists only what
 * differs — which keeps each content file a readable copy of the source.
 */
import type {
  BoxKind,
  BoxSide,
  DiagramBox,
  DiagramGroup,
  DiagramLink,
  LinkKind,
} from '../../types';

interface BoxOptions {
  w?: number;
  h?: number;
  sub?: string;
  ex?: string;
  ref?: string;
  kind?: BoxKind;
  pills?: readonly string[];
}

export function box(
  id: string,
  x: number,
  y: number,
  title: string,
  options: BoxOptions = {},
): DiagramBox {
  return {
    id,
    x,
    y,
    title,
    w: options.w ?? 170,
    h: options.h ?? 96,
    sub: options.sub ?? '',
    ex: options.ex ?? '',
    ref: options.ref ?? '',
    kind: options.kind ?? 'place',
    pills: options.pills ?? [],
  };
}

interface LinkOptions {
  k?: LinkKind;
  fs?: BoxSide;
  ts?: BoxSide;
  ff?: number;
  tf?: number;
  mx?: number;
  my?: number;
  at?: readonly [number, number];
}

export function link(
  from: string,
  to: string,
  label: string,
  options: LinkOptions = {},
): DiagramLink {
  const { k = 'solid', fs = 'r', ts = 'l', ff = 0.5, tf = 0.5, ...elbow } = options;
  return { from, to, label, k, fs, ts, ff, tf, ...elbow };
}

export function group(x: number, y: number, w: number, h: number, label: string): DiagramGroup {
  return { x, y, w, h, label };
}
