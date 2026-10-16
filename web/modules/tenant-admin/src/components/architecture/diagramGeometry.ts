/**
 * Orthogonal link routing for the architecture diagrams — the design
 * document's `build()` as a pure function of the section content.
 *
 * A link leaves a point on one side of its source box and enters a point on
 * one side of its target: two horizontal sides are joined by a straight run or
 * two bends at `mx` (default halfway), two vertical sides likewise at `my`, and
 * a horizontal side meets a vertical one with a single bend. The arrowhead
 * points along the last segment; the label sits on the middle run of a
 * two-bend link and on the first run otherwise, lifted 14 units off a
 * horizontal run. Links of one kind share one SVG path, so a diagram draws
 * four line paths and four arrowhead paths whatever its size.
 */
import type { ArchitectureSection, BoxSide, DiagramBox, DiagramLink, LinkKind } from './types';

export type Point = readonly [number, number];

type HeadDirection = 'r' | 'l' | 'u' | 'd';

export interface LinkLabel {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  /** The label names a dated link (one with a start and an end): drawn framed */
  readonly dated: boolean;
  readonly kind: LinkKind;
}

export interface RoutedLink {
  readonly kind: LinkKind;
  readonly points: readonly Point[];
  readonly path: string;
  readonly head: string;
  readonly label?: LinkLabel;
}

export interface LinkLayer {
  readonly line: string;
  readonly heads: string;
}

export interface RoutedSection {
  readonly layers: Readonly<Record<LinkKind, LinkLayer>>;
  readonly labels: readonly LinkLabel[];
}

export const LINK_KINDS: readonly LinkKind[] = ['solid', 'assign', 'data', 'ctrl'];

const HEAD_VECTORS: Readonly<Record<HeadDirection, Point>> = {
  r: [1, 0],
  l: [-1, 0],
  u: [0, -1],
  d: [0, 1],
};

/** A closed triangle, 9 deep and 10 wide, with its tip at (x, y). */
export function arrowHead(x: number, y: number, direction: HeadDirection): string {
  const [dx, dy] = HEAD_VECTORS[direction];
  return `M${x} ${y}L${x - dx * 9 - dy * 5} ${y - dy * 9 - dx * 5}L${x - dx * 9 + dy * 5} ${y - dy * 9 + dx * 5}Z`;
}

function sidePoint(box: DiagramBox, side: BoxSide, fraction: number): Point {
  switch (side) {
    case 'r':
      return [box.x + box.w, box.y + box.h * fraction];
    case 'l':
      return [box.x, box.y + box.h * fraction];
    case 't':
      return [box.x + box.w * fraction, box.y];
    case 'b':
      return [box.x + box.w * fraction, box.y + box.h];
  }
}

const isHorizontal = (side: BoxSide): boolean => side === 'l' || side === 'r';

function route(start: Point, end: Point, link: DiagramLink): readonly Point[] {
  const [x1, y1] = start;
  const [x2, y2] = end;
  const fromHorizontal = isHorizontal(link.fs);
  const toHorizontal = isHorizontal(link.ts);
  if (fromHorizontal && toHorizontal) {
    if (Math.abs(y1 - y2) < 0.5) return [start, end];
    const xm = link.mx ?? (x1 + x2) / 2;
    return [start, [xm, y1], [xm, y2], end];
  }
  if (!fromHorizontal && !toHorizontal) {
    if (Math.abs(x1 - x2) < 0.5) return [start, end];
    const ym = link.my ?? (y1 + y2) / 2;
    return [start, [x1, ym], [x2, ym], end];
  }
  return fromHorizontal ? [start, [x2, y1], end] : [start, [x1, y2], end];
}

function headDirection(before: Point, tip: Point): HeadDirection {
  if (tip[0] > before[0] + 0.1) return 'r';
  if (tip[0] < before[0] - 0.1) return 'l';
  return tip[1] > before[1] ? 'd' : 'u';
}

function labelFor(link: DiagramLink, points: readonly Point[]): LinkLabel | undefined {
  if (!link.label) return undefined;
  const [s0, s1] = points.length === 4 ? [points[1], points[2]] : [points[0], points[1]];
  const horizontalRun = Math.abs(s0[1] - s1[1]) < 0.5;
  const [x, y] = link.at ?? [(s0[0] + s1[0]) / 2, (s0[1] + s1[1]) / 2 - (horizontalRun ? 14 : 0)];
  return { text: link.label, x, y, dated: /tarihli/.test(link.label), kind: link.k };
}

function boxOf(boxes: ReadonlyMap<string, DiagramBox>, id: string): DiagramBox {
  const found = boxes.get(id);
  // Content is static and pinned by architectureContent.spec; an unknown id is
  // a porting error, so it fails loudly instead of silently dropping the link.
  if (!found)
    throw new Error(`Diagram link points at box "${id}", which the section does not draw`);
  return found;
}

export function routeLink(link: DiagramLink, boxes: ReadonlyMap<string, DiagramBox>): RoutedLink {
  const start = sidePoint(boxOf(boxes, link.from), link.fs, link.ff);
  const end = sidePoint(boxOf(boxes, link.to), link.ts, link.tf);
  const points = route(start, end, link);
  const tip = points[points.length - 1];
  const before = points[points.length - 2];
  return {
    kind: link.k,
    points,
    path: `M${points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}`,
    head: arrowHead(tip[0], tip[1], headDirection(before, tip)),
    label: labelFor(link, points),
  };
}

export function routeSection(section: ArchitectureSection): RoutedSection {
  const boxes = new Map(section.boxes.map((item) => [item.id, item]));
  const routed = section.links.map((item) => routeLink(item, boxes));
  const layer = (kind: LinkKind): LinkLayer => {
    const ofKind = routed.filter((item) => item.kind === kind);
    return {
      line: ofKind.map((item) => item.path).join(' '),
      heads: ofKind.map((item) => item.head).join(' '),
    };
  };
  return {
    layers: {
      solid: layer('solid'),
      assign: layer('assign'),
      data: layer('data'),
      ctrl: layer('ctrl'),
    },
    labels: routed.flatMap((item) => (item.label ? [item.label] : [])),
  };
}
