/**
 * Writes the Production workspace's console motif from the login reef art
 * (FE-MEDIUM-348).
 *
 * WHAT: a static tile of fish silhouettes — the reef scene's own species on
 * its three depth planes, a far fish fainter than a near one — that
 * suderra.css uses as the mask of the Production workspace's motif layer
 * (`[data-ws='aqua'] .sd-content::after`). The layer paints the workspace
 * accent through it at the theme's motif opacity, so the file carries no
 * colour: a mask reads coverage only, and every filled shape of a fish keeps
 * its geometry and drops its paint.
 *
 * WHY generated rather than drawn: the fish are drawn once, in
 * `web/shell/src/components/reef/art/*.svg`, for the login scene. A
 * hand-copied silhouette file would be a second drawing that drifts the
 * first time an artist touches a fish; derived, the console's reef is the
 * login's reef. `tests/invariants/web-console-motif-generated.spec.ts`
 * regenerates and diffs, so a hand edit or a stale tile fails the build.
 *
 *   npx tsx tools/design/generate-console-motifs.ts [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

export const REEF_ART_DIR = 'web/shell/src/components/reef/art';
export const AQUA_MOTIF_PATH = 'web/shared-ui/src/styles/motifs/aqua.svg';

/** The reef's species, the baitfish school included — every one appears in the tile. */
export const MOTIF_SPECIES = [
  'salmon',
  'bass',
  'bream',
  'trout',
  'mackerel',
  'turbot',
  'tuna',
  'bait',
] as const;
type Species = (typeof MOTIF_SPECIES)[number];

/** The tile, in px; suderra.css repeats it at this size (its `mask-size`). */
const TILE = { width: 1200, height: 800 } as const;

/** The login scene's depth planes as coverage: a far fish is fainter, as it is there. */
const DEPTH = { far: 0.45, mid: 0.7, near: 1 } as const;
type Depth = keyof typeof DEPTH;

interface Placement {
  readonly species: Species;
  /** Top-left corner of the fish's box in the tile, and its width (the height follows the art). */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  /** The art faces right; `left` mirrors it. */
  readonly facing: 'left' | 'right';
  readonly depth: Depth;
}

/**
 * Where each fish swims in the tile. Every box stays inside the tile, so the
 * repeat never cuts a fish at a seam; the bottom-dwelling turbot keeps to the
 * floor of the tile as it keeps to the floor of the login scene.
 */
const FISH: readonly Placement[] = [
  { species: 'salmon', x: 70, y: 110, width: 200, facing: 'right', depth: 'near' },
  { species: 'bass', x: 470, y: 70, width: 120, facing: 'left', depth: 'far' },
  { species: 'bream', x: 930, y: 120, width: 120, facing: 'left', depth: 'mid' },
  { species: 'mackerel', x: 560, y: 330, width: 160, facing: 'right', depth: 'mid' },
  { species: 'trout', x: 150, y: 400, width: 170, facing: 'left', depth: 'mid' },
  { species: 'bream', x: 1030, y: 420, width: 84, facing: 'right', depth: 'far' },
  { species: 'tuna', x: 790, y: 590, width: 240, facing: 'left', depth: 'near' },
  { species: 'salmon', x: 400, y: 600, width: 130, facing: 'left', depth: 'far' },
  { species: 'turbot', x: 90, y: 660, width: 124, facing: 'right', depth: 'far' },
];

/**
 * The baitfish school: eleven fish on a golden-angle spiral round one
 * anchor, so the cluster reads as a school without a random generator (the
 * output must be the same on every run).
 */
function school(anchorX: number, anchorY: number): Placement[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: 11 }, (_, i): Placement => {
    const radius = 15 * Math.sqrt(i + 0.5);
    return {
      species: 'bait',
      x: Math.round(anchorX + 2.4 * radius * Math.cos(i * golden)),
      y: Math.round(anchorY + radius * Math.sin(i * golden)),
      width: [30, 26, 34][i % 3] ?? 30,
      facing: 'right',
      depth: 'far',
    };
  });
}

const PLACEMENTS: readonly Placement[] = [...FISH, ...school(760, 210)];

export interface Silhouette {
  /** The art's viewBox size. */
  readonly width: number;
  readonly height: number;
  /** Every filled shape, geometry only. */
  readonly shapes: readonly string[];
}

const SHAPE = /<(path|ellipse|circle)\b([^>]*?)\/?>/g;
const GEOMETRY = ['d', 'cx', 'cy', 'r', 'rx', 'ry', 'transform'] as const;

function attribute(attrs: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];
}

/**
 * One fish's coverage: its filled shapes without their paint. A stroke-only
 * shape (a lateral line, a scale highlight) adds no area and is dropped; the
 * gradients in `<defs>` are paint and go with it.
 */
export function silhouette(svg: string): Silhouette {
  const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (viewBox?.[1] === undefined || viewBox[2] === undefined)
    throw new Error('reef art without a `viewBox="0 0 w h"`');
  const shapes: string[] = [];
  for (const [, tag, attrs = ''] of svg.replace(/<defs>[\s\S]*?<\/defs>/g, '').matchAll(SHAPE)) {
    const fill = attribute(attrs, 'fill');
    if (fill === 'none' || (fill === undefined && attribute(attrs, 'stroke') !== undefined))
      continue;
    const geometry = GEOMETRY.map((name) => {
      const value = attribute(attrs, name);
      return value === undefined ? '' : ` ${name}="${value}"`;
    }).join('');
    shapes.push(`<${tag}${geometry}/>`);
  }
  return { width: Number(viewBox[1]), height: Number(viewBox[2]), shapes };
}

/** Two decimals at most, no trailing zeros: the tile stays small and diffs stay readable. */
function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function readArt(species: Species): string {
  return readFileSync(resolve(REPO_ROOT, REEF_ART_DIR, `${species}.svg`), 'utf8');
}

/** The motif file's full text, from the reef art (`read` is the art loader, swappable in tests). */
export function renderAquaMotif(read: (species: Species) => string = readArt): string {
  const art = new Map(MOTIF_SPECIES.map((species) => [species, silhouette(read(species))]));
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE.width} ${TILE.height}" width="${TILE.width}" height="${TILE.height}">`,
    `<!-- Generated by tools/design/generate-console-motifs.ts from ${REEF_ART_DIR} (FE-MEDIUM-348). Do not edit. -->`,
  ];
  for (const fish of PLACEMENTS) {
    const shape = art.get(fish.species);
    if (shape === undefined) throw new Error(`no reef art for ${fish.species}`);
    const scale = fish.width / shape.width;
    const transform =
      fish.facing === 'right'
        ? `translate(${num(fish.x)} ${num(fish.y)}) scale(${num(scale)})`
        : `translate(${num(fish.x + fish.width)} ${num(fish.y)}) scale(${num(-scale)} ${num(scale)})`;
    const opacity = DEPTH[fish.depth] === 1 ? '' : ` opacity="${DEPTH[fish.depth]}"`;
    lines.push(`<g transform="${transform}"${opacity}>${shape.shapes.join('')}</g>`);
  }
  lines.push('</svg>', '');
  return lines.join('\n');
}

function main(): void {
  const file = resolve(REPO_ROOT, AQUA_MOTIF_PATH);
  const next = renderAquaMotif();
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // First run: the file does not exist yet.
  }
  if (process.argv.includes('--check')) {
    if (current !== next) {
      process.stderr.write(
        `${AQUA_MOTIF_PATH} is stale — run \`npx tsx tools/design/generate-console-motifs.ts\`.\n`,
      );
      process.exit(1);
    }
    process.stdout.write('Console motif is up to date.\n');
    return;
  }
  if (current !== next) writeFileSync(file, next);
  process.stdout.write(
    current === next ? 'Console motif unchanged.\n' : `Wrote ${AQUA_MOTIF_PATH}\n`,
  );
}

if (require.main === module) {
  main();
}
