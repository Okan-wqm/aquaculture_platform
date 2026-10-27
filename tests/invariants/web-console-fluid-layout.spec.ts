/**
 * INVARIANT: the console's page follows the window.
 *
 * # Why
 *
 * The tenant console's `<main>` was capped at 1520 px and the `sd-stack` page
 * rhythm at 1920 px (centred). Past the cap the page stopped growing: a user who
 * widened the window got a frozen column and empty ground beside it, which read
 * as "the content does not follow the page". The page's width is the console
 * column's (`.sd-content`, the `page` container every console query reads), so
 * nothing between the column and a page's own layout may pin a pixel width.
 *
 * Page-level wrappers that cap a form or a column of prose keep their own limit
 * on purpose (a form field does not need 3000 px); this guard covers the shared
 * frame every page inherits, where a cap is never a reading-width choice.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { suderraRule } from './lib/web-console-theme';

const REPO_ROOT = resolve(__dirname, '../..');

describe('INVARIANT: the console page follows the window', () => {
  it('ConsoleShell <main> carries no fixed pixel max-width', () => {
    const source = readFileSync(
      resolve(REPO_ROOT, 'web/shell/src/console/ConsoleShell.tsx'),
      'utf8',
    );
    const mainClass = /<main\b[^>]*?className="([^"]*)"/s.exec(source)?.[1] ?? '';
    expect(mainClass).toContain('sd-main');
    // A fixed max-width freezes the page while the window grows; mx-auto centres it in a narrower box.
    const pinned = mainClass
      .split(/\s+/)
      .filter((name) => /^max-w-\[\d+px\]$/.test(name) || name === 'mx-auto');
    expect(pinned).toEqual([]);
  });

  it('the console column, its main and the page stack are neither capped nor centred', () => {
    const offenders = ['.sd-content', '.sd-main', '.sd-stack'].filter((selector) =>
      /max-width\s*:|margin-inline\s*:\s*auto/.test(suderraRule(selector)),
    );
    expect(offenders).toEqual([]);
  });
});
