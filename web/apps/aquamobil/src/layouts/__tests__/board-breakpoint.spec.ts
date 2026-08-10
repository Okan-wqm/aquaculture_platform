/**
 * The board threshold exists twice — once as a Tailwind `screens` entry and once
 * as a JS media query — because a Tailwind config cannot import from the TS
 * program that the app is compiled from. Two literals that must agree and cannot
 * reference each other is exactly the shape of a silent drift, so this gate
 * makes the drift a red test instead of a board that swaps its shell at one
 * width and its column widths at another.
 *
 * It also holds the "no laptop ladder" decision: the default sm/md/lg/xl/2xl
 * screens are REPLACED, not extended, so an accidental desktop breakpoint is
 * impossible rather than merely discouraged.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BOARD_MEDIA_QUERY, BOARD_WIDE_MEDIA_QUERY } from '@/hooks/useViewport';

const TAILWIND_CONFIG = readFileSync(
  resolve(__dirname, '../../../tailwind.config.js'),
  'utf8',
).replace(/\/\/[^\n]*/g, ''); // strip comments: the gate judges CONFIG, not prose

describe('board breakpoint', () => {
  it('declares the same query string in Tailwind as the JS switch uses', () => {
    expect(TAILWIND_CONFIG, 'the `board` screen does not match BOARD_MEDIA_QUERY').toContain(
      `board: { raw: '${BOARD_MEDIA_QUERY}' }`,
    );
    expect(
      TAILWIND_CONFIG,
      'the `board-wide` screen does not match BOARD_WIDE_MEDIA_QUERY',
    ).toContain(`'board-wide': { raw: '${BOARD_WIDE_MEDIA_QUERY}' }`);
  });

  it('keeps the height term — width alone would give a phone in landscape the board', () => {
    // The widest phone in landscape (932×430) clears any width-only threshold a
    // tablet can also clear. Dropping `min-height` is therefore not a
    // simplification, it is the bug.
    for (const query of [BOARD_MEDIA_QUERY, BOARD_WIDE_MEDIA_QUERY]) {
      expect(query).toMatch(/\(min-height:\s*600px\)/);
    }
    expect(BOARD_MEDIA_QUERY).toMatch(/\(min-width:\s*900px\)/);
  });

  it('ships no desktop breakpoint ladder — the two board screens are the whole set', () => {
    // `screens` at theme level REPLACES Tailwind's defaults. If someone moves it
    // under `extend`, sm/md/lg/xl/2xl come back and a laptop-shaped layout
    // becomes writable again; this reads the declared set to catch that.
    const block = / {4}screens:\s*\{([\s\S]*?)\n {4}\},/.exec(TAILWIND_CONFIG);
    expect(
      block,
      '`screens` is not declared at theme level (it must not sit under `extend`)',
    ).not.toBeNull();

    const declared = Array.from(
      (block?.[1] ?? '').matchAll(/^\s*'?([a-z0-9-]+)'?:\s*\{/gm),
      (match) => match[1],
    );
    expect(
      declared,
      'This app has a phone case and a cabin-tablet case. There is no laptop case, so there is no third breakpoint.',
    ).toEqual(['board', 'board-wide']);
  });
});
