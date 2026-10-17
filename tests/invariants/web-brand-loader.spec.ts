/**
 * INVARIANT (FE-MEDIUM-349): one loading screen, from the first paint on.
 *
 * # Why
 *
 * A refresh used to show up to four loading screens in a row, each drawn
 * differently: the index.html boot splash (a blue square and a spinner in
 * hand-typed hex), the shell's PageLoading or the auth layout's spinner,
 * RemoteModuleLoader, then each remote's own Suspense fallback. The owner's
 * decision (2026-10-17) is one loader — shared-ui's BrandLoader — and a boot
 * splash that is the same visual, so the hand-off shows nothing changing.
 *
 * # The rules
 *
 * 1. index.html cannot load the design system's stylesheet before it
 *    paints, so the loader's colours and face arrive there as a generated
 *    copy of the theme.css tokens (`tools/design/generate-boot-splash.ts`,
 *    the edge page's convention): regenerating changes nothing, and no other
 *    colour is spelled in the file.
 * 2. Every Suspense fallback that guards routes — the shell's and each
 *    remote's — is the BrandLoader, and the loaders it replaced are gone.
 *    Fallbacks inside a page that stand in for one widget (a skeleton the
 *    widget's size, the code editor) are placeholders, not loading screens,
 *    and are not routes.
 *
 * web/shell/src/__tests__/bootSplash.spec.tsx holds the splash markup and
 * stylesheet to the component.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  INDEX_HTML_PATH,
  THEME_CSS_PATH,
  TOKENS_BEGIN,
  TOKENS_END,
  renderIndexHtml,
} from '../../tools/design/generate-boot-splash';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

const COLOUR =
  /(?<![\w&#$])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?|oklch)\(/g;

describe('INVARIANT (FE-MEDIUM-349): one loading screen, from the first paint on', () => {
  it("index.html's loader tokens and theme colour are the generator's, current with theme.css", () => {
    const html = read(INDEX_HTML_PATH);
    expect(html).toContain(TOKENS_BEGIN);
    expect(renderIndexHtml(html, read(THEME_CSS_PATH))).toBe(html);
  });

  it('index.html spells no colour of its own outside the generated copy', () => {
    const html = read(INDEX_HTML_PATH);
    const outside =
      html.slice(0, html.indexOf(TOKENS_BEGIN)) +
      html.slice(html.indexOf(TOKENS_END) + TOKENS_END.length);
    const handTyped = outside
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<meta name="theme-color" content="#[0-9a-f]{6}" \/>/, '')
      .match(COLOUR);
    expect(handTyped).toBeNull();
  });

  it('every Suspense fallback that guards routes is the BrandLoader', () => {
    const files = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', '--', 'web/shell/src', 'web/modules'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(
        (file) =>
          file.endsWith('.tsx') &&
          !file.includes('__tests__') &&
          !/\.(spec|test)\.tsx$/.test(file) &&
          !file.includes('/node_modules/'),
      )
      .filter((file) => {
        const source = read(file);
        return source.includes('<Routes') && source.includes('fallback=');
      });
    // The shell's routes and every remote that lazy-loads its pages: not vacuous.
    expect(files.length).toBeGreaterThanOrEqual(8);
    const offenders = files.flatMap((file) =>
      [...read(file).matchAll(/\bfallback=\{\s*(<?[\w.]*)/g)]
        .map(([, element]) => element)
        .filter((element) => element !== '<BrandLoader')
        .map((element) => `${file}: fallback ${element}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the loaders it replaced are gone, and the guards and session checks render it', () => {
    expect(existsSync(resolve(REPO_ROOT, 'web/shell/src/components/RemoteModuleLoader.tsx'))).toBe(
      false,
    );
    expect(read('web/shared-ui/src/components/Loading/Loading.tsx')).not.toMatch(
      /export const PageLoading\b/,
    );
    expect(read('web/shared-ui/src/components/guards/GuardLoading.tsx')).toMatch(/<BrandLoader\b/);
    // The shell's session checks: the protected routes' guard (routing/, where
    // App.tsx mounts it from) and the auth layout's.
    for (const file of [
      'web/shell/src/routing/ProtectedRoute.tsx',
      'web/shell/src/layouts/AuthLayout.tsx',
    ])
      expect({ file, screen: /<BrandLoader\s+variant="screen"/.test(read(file)) }).toEqual({
        file,
        screen: true,
      });
  });
});
