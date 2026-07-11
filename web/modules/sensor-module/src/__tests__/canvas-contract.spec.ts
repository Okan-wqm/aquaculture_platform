/**
 * Canvas-contract invariants (SENSOR-MEDIUM-005).
 *
 * The host↔iframe boundary of the P&ID canvas is governed by ONE module —
 * src/canvas-contract.ts. These invariants make every historical failure mode
 * of that boundary build-time detectable:
 *  - the URL constants drifting from the module's real Vite `base`,
 *  - stringly-typed protocol literals reappearing outside the contract,
 *  - the canvas app regressing to window-global (CDN UMD) dependency reads,
 *  - the canvas entry HTML regressing to external <script>/<link> hosts,
 *  - the build pipeline dropping the canvas pre-build or the artifact gate
 *    (the stale-dist class: a dist without a bundled canvas shipping to
 *    /remotes unnoticed).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROCESS_EDITOR_CANVAS_URL, SCADA_VIEWER_CANVAS_URL, SENSOR_MODULE_BASE } from '../canvas-contract';

const MODULE_ROOT = resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(join(MODULE_ROOT, rel), 'utf8');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(ts|tsx|jsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('canvas contract SSoT', () => {
  it('URL constants derive from the exact Vite base of the module', () => {
    const viteConfig = read('vite.config.ts');
    const base = viteConfig.match(/base:\s*'([^']+)'/)?.[1];
    expect(base).toBe(SENSOR_MODULE_BASE);
    expect(PROCESS_EDITOR_CANVAS_URL).toBe(`${SENSOR_MODULE_BASE}process-editor-canvas.html`);
    expect(SCADA_VIEWER_CANVAS_URL).toBe(`${SENSOR_MODULE_BASE}scada-viewer-canvas.html`);
  });

  it('no protocol literal or hand-rolled canvas URL exists outside the contract', () => {
    const files = [...walk(join(MODULE_ROOT, 'src')), ...walk(join(MODULE_ROOT, 'canvas'))];
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith('canvas-contract.ts')) continue;
      const content = readFileSync(file, 'utf8');
      if (/'process-editor-host'|'process-editor-canvas'(?!\.html)/.test(content)) {
        offenders.push(`${file}: protocol source literal — import it from canvas-contract.ts`);
      }
      if (/getCanvasUrl\s*=/.test(content)) {
        offenders.push(`${file}: hand-rolled getCanvasUrl — use the canvas-contract URL constants`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the bundled canvas app reads deps from imports, never window globals or CDNs', () => {
    const main = read('canvas/main.jsx');
    expect(main).not.toMatch(/window\.(ReactFlow|AquacultureNodes|Recharts)\b/);
    expect(main).not.toMatch(/unpkg\.com|cdn\.jsdelivr\.net|cdn\.tailwindcss\.com/);
  });

  it('the canvas entry HTML is a pure module entry with no external hosts', () => {
    const entry = read('process-editor-canvas.html');
    expect(entry).not.toMatch(/https?:\/\//);
    expect(entry).toMatch(/type="module"/);
  });

  it('build AND dev run the canvas pre-build, and build ends with the artifact gate', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toMatch(/vite build --config vite\.canvas\.config\.ts/);
    expect(pkg.scripts.dev).toMatch(/vite build --config vite\.canvas\.config\.ts/);
    // The gate makes "dist without a bundled canvas" unproducible via the target.
    expect(pkg.scripts.build).toMatch(/assert-canvas-artifact\.mjs\s*$/);
  });
});
