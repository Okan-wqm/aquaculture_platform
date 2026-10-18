// @vitest-environment node
/**
 * The unresolved-asset-URL gate (FE-MEDIUM-348): a federation build fails
 * where Vite would have shipped a stylesheet `url()` it never emitted.
 *
 * The workspace motifs shipped that way: Vite warned "… didn't resolve at
 * build time, it will remain unchanged to be resolved at runtime", the build
 * passed, and production requested `/assets/motifs/*.svg`, which nginx 404s.
 * These cases build a stylesheet with Vite itself, so they also pin the
 * contract the gate relies on — that the warning reaches the configured
 * logger, in these words, while the stylesheet is transformed — and a Vite
 * upgrade that moved it would fail here rather than let the gate go quiet.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build, type Logger, type Plugin, type Rollup } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  UNRESOLVED_ASSET_URL_GATE,
  UNRESOLVED_ASSET_URL_WARNING,
  failOnUnresolvedAssetUrls,
  unresolvedAssetUrlGate,
} from '../unresolvedAssetUrlGate';

/** The warning as the shell's CI build printed it for the motifs (Frontend Lighthouse run 39058917903). */
const VITE_WARNING = `\n./motifs/aqua.svg referenced in ./motifs/aqua.svg ${UNRESOLVED_ASSET_URL_WARNING}, it will remain unchanged to be resolved at runtime`;

/** A blank square, inlined: what a stylesheet that resolves its art carries. */
const DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8'/%3E%3C/svg%3E";

function fakeLogger(): Logger {
  return {
    hasWarned: false,
    info: vi.fn(),
    warn: vi.fn(),
    warnOnce: vi.fn(),
    error: vi.fn(),
    clearScreen: vi.fn(),
    hasErrorLogged: vi.fn(() => false),
  };
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Builds `main.js` importing a stylesheet whose mask is `mask`; resolves to the emitted CSS. */
async function buildStylesheet(mask: string, plugins: Plugin[]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'asset-url-gate-'));
  roots.push(root);
  writeFileSync(join(root, 'style.css'), `.layer { mask-image: url("${mask}"); }\n`);
  writeFileSync(join(root, 'main.js'), "import './style.css';\n");
  const output = (await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins,
    build: {
      write: false,
      cssCodeSplit: false,
      rollupOptions: { input: join(root, 'main.js') },
    },
  })) as Rollup.RollupOutput;
  const css = output.output.find(
    (file): file is Rollup.OutputAsset => file.type === 'asset' && file.fileName.endsWith('.css'),
  );
  return typeof css?.source === 'string' ? css.source : '';
}

describe('failOnUnresolvedAssetUrls', () => {
  it("throws on Vite's unresolved-url warning, from warn and from warnOnce", () => {
    const base = fakeLogger();
    const logger = failOnUnresolvedAssetUrls(base);
    for (const log of [logger.warn, logger.warnOnce]) {
      expect(() => log(VITE_WARNING)).toThrow(
        `[${UNRESOLVED_ASSET_URL_GATE}] ./motifs/aqua.svg referenced in ./motifs/aqua.svg ${UNRESOLVED_ASSET_URL_WARNING}`,
      );
    }
    expect(base.warn).not.toHaveBeenCalled();
    expect(base.warnOnce).not.toHaveBeenCalled();
  });

  it('passes every other message to the logger Vite would have used', () => {
    const base = fakeLogger();
    const logger = failOnUnresolvedAssetUrls(base);
    logger.info('built in 1s', { timestamp: true });
    logger.warn('chunk larger than 500 kB');
    logger.warnOnce('a plugin is deprecated');
    logger.error('boom');
    logger.clearScreen('info');
    expect(base.info).toHaveBeenCalledWith('built in 1s', { timestamp: true });
    expect(base.warn).toHaveBeenCalledWith('chunk larger than 500 kB', undefined);
    expect(base.warnOnce).toHaveBeenCalledWith('a plugin is deprecated', undefined);
    expect(base.error).toHaveBeenCalledWith('boom', undefined);
    expect(base.clearScreen).toHaveBeenCalledWith('info');
    base.hasWarned = true;
    expect(logger.hasWarned).toBe(true);
  });
});

describe('unresolvedAssetUrlGate — a real Vite build', () => {
  it('without the gate, Vite ships the unresolved url() as written: the defect it closes', async () => {
    const css = await buildStylesheet('./motifs/missing.svg', []);
    expect(css).toContain('./motifs/missing.svg');
  });

  it('with the gate, the same build fails and names the url and the stylesheet', async () => {
    await expect(
      buildStylesheet('./motifs/missing.svg', [unresolvedAssetUrlGate()]),
    ).rejects.toThrow(
      new RegExp(
        `\\[${UNRESOLVED_ASSET_URL_GATE}\\] \\./motifs/missing\\.svg referenced in [^\\n]* ${UNRESOLVED_ASSET_URL_WARNING}[\\s\\S]*file: .*/style\\.css`,
      ),
    );
  });

  it('passes a stylesheet whose art is inlined, and ships it as written', async () => {
    const css = await buildStylesheet(DATA_URI, [unresolvedAssetUrlGate()]);
    expect(css).toContain(DATA_URI);
  });

  it('applies to builds only: the dev server resolves through its own module graph', () => {
    expect(unresolvedAssetUrlGate().apply).toBe('build');
  });
});
