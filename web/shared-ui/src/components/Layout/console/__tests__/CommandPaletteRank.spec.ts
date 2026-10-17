/**
 * Command palette ranking (FE-HIGH-334) — what the palette lists for a query,
 * in which groups, in which order, and how many.
 */
import { describe, expect, it } from 'vitest';

import {
  PALETTE_GROUP_LIMITS,
  PALETTE_SUGGESTED_PAGES,
  foldForSearch,
  paletteNotices,
  rankPalette,
} from '../CommandPaletteRank';
import type {
  PaletteCommandEntry,
  PaletteLinkEntry,
  PaletteRemoteSource,
  PaletteSources,
} from '../CommandPaletteTypes';

function page(label: string, extra: Partial<PaletteLinkEntry> = {}): PaletteLinkEntry {
  return { kind: 'link', id: `/p/${label}`, label, path: `/p/${label}`, ...extra };
}

function command(label: string): PaletteCommandEntry {
  return { kind: 'command', id: label, label, command: { type: 'rail', collapsed: true } };
}

const NOT_ASKED: PaletteRemoteSource = { status: 'unavailable' };

function sources(over: Partial<PaletteSources> = {}): PaletteSources {
  return { pages: [], people: NOT_ASKED, devices: NOT_ASKED, commands: [], ...over };
}

function labels(result: ReturnType<typeof rankPalette>, group: string): string[] {
  return result.find((section) => section.group === group)?.entries.map((e) => e.label) ?? [];
}

describe('foldForSearch', () => {
  it('drops case and diacritics, Turkish dotted and dotless i included', () => {
    expect(foldForSearch('İLKER Şahin')).toBe('ilker sahin');
    expect(foldForSearch('Işık')).toBe('isik');
    expect(foldForSearch('Soğutma Çevrimi')).toBe('sogutma cevrimi');
  });

  it('folds the letters Unicode does not decompose, as it folds å', () => {
    // NFKD splits å into a + ring but leaves ø, æ, đ, ł, ß whole, so without
    // a letter map "bjorn" missed Bjørn while "agard" found Ågård. A reader
    // on a Turkish or English keyboard types them as their base letters.
    expect(foldForSearch('Bjørn Ågård')).toBe('bjorn agard');
    expect(foldForSearch('ÆRLIG Øksnes')).toBe('aerlig oksnes');
    expect(foldForSearch('Œuvre Đorđe Łódź Straße')).toBe('oeuvre dorde lodz strasse');
  });

  it('folds a query and a label to the same text, so either spelling finds the other', () => {
    expect(foldForSearch('bjorn')).toBe(foldForSearch('Bjørn'));
    expect(foldForSearch('bjørn')).toBe(foldForSearch('BJORN'));
    expect(foldForSearch('aerlig')).toBe(foldForSearch('Ærlig'));
  });
});

describe('rankPalette — before anything is typed', () => {
  it('lists the commands, then the first top-level pages; no people or devices', () => {
    const pages = [
      page('Dashboard'),
      page('Feeding'),
      page('Feeding › Forecast', { nested: true }),
      ...['Alarms', 'Tanks', 'Health', 'Tasks', 'Reports'].map((label) => page(label)),
    ];
    const ready: PaletteRemoteSource = { status: 'ready', entries: [page('Ali Veli')] };
    const result = rankPalette(
      sources({ pages, commands: [command('Collapse navigation')], people: ready, devices: ready }),
      '   ',
    );

    expect(result.map((section) => section.group)).toEqual(['commands', 'pages']);
    expect(labels(result, 'commands')).toEqual(['Collapse navigation']);
    expect(labels(result, 'pages')).toEqual([
      'Dashboard',
      'Feeding',
      'Alarms',
      'Tanks',
      'Health',
      'Tasks',
    ]);
    expect(labels(result, 'pages')).toHaveLength(PALETTE_SUGGESTED_PAGES);
  });

  it('lists the suggested pages instead, in the order given, when the caller names them', () => {
    const pages = [
      page('Dashboard'),
      page('Feeding'),
      page('Feeding › Forecast', { nested: true }),
      page('Tanks'),
      page('Users'),
    ];
    const result = rankPalette(
      sources({
        pages,
        suggested: ['/p/Users', '/p/Dashboard', '/p/Feeding › Forecast', '/p/Users', '/p/Billing'],
      }),
      '',
    );
    // Each named page once, a tab too when named; a path the palette was not
    // handed as a page (Billing) is never suggested.
    expect(labels(result, 'pages')).toEqual(['Users', 'Dashboard', 'Feeding › Forecast']);
    expect(rankPalette(sources({ pages, suggested: [] }), '')).toEqual([]);
  });

  it('searches every page with a query, not only the suggested ones', () => {
    const pages = [page('Dashboard'), page('Tanks')];
    expect(
      labels(rankPalette(sources({ pages, suggested: ['/p/Dashboard'] }), 'tank'), 'pages'),
    ).toEqual(['Tanks']);
  });

  it('drops a group with nothing in it', () => {
    expect(rankPalette(sources({ pages: [page('Dashboard')] }), '')).toEqual([
      { group: 'pages', entries: [page('Dashboard')] },
    ]);
    expect(rankPalette(sources(), '')).toEqual([]);
  });
});

describe('rankPalette — with a query', () => {
  it('orders the groups pages, people, devices, commands and drops the empty ones', () => {
    const result = rankPalette(
      sources({
        pages: [page('Water quality')],
        people: { status: 'ready', entries: [page('Walter White')] },
        devices: { status: 'ready', entries: [page('Pump 3')] },
        commands: [command('Switch to dark theme')],
      }),
      'wa',
    );
    expect(result.map((section) => section.group)).toEqual(['pages', 'people']);
  });

  it('ranks an exact label over a prefix, a word start, a substring, then context matches', () => {
    const pages = [
      page('Tank feeding log'), // a word of the label starts with it
      page('Biofeed'), // inside a word
      page('Feeding plan'), // the label starts with it
      page('Overview', { keywords: ['Feeding area'] }), // only a keyword
      page('Feed'), // the whole label
      page('Stock', { keywords: ['feed store'] }), // only a keyword
    ];
    expect(labels(rankPalette(sources({ pages }), 'feed'), 'pages')).toEqual([
      'Feed',
      'Feeding plan',
      'Tank feeding log',
      'Biofeed',
      'Overview',
      'Stock',
    ]);
  });

  it('keeps the given order between equally good matches', () => {
    const pages = [page('Feed stock'), page('Feed types'), page('Feed orders')];
    expect(labels(rankPalette(sources({ pages }), 'feed'), 'pages')).toEqual([
      'Feed stock',
      'Feed types',
      'Feed orders',
    ]);
  });

  it('matches without case or diacritics', () => {
    const pages = [page('Soğutma'), page('İlaçlama')];
    expect(labels(rankPalette(sources({ pages }), 'SOGUT'), 'pages')).toEqual(['Soğutma']);
    expect(labels(rankPalette(sources({ pages }), 'ilac'), 'pages')).toEqual(['İlaçlama']);
  });

  it('matches every word of a several-word query anywhere in the label or its keywords', () => {
    const pages = [
      page('Feeding › Forecast', { nested: true, keywords: ['Operations'] }),
      page('Forecasting'),
    ];
    expect(labels(rankPalette(sources({ pages }), 'feed fore'), 'pages')).toEqual([
      'Feeding › Forecast',
    ]);
    expect(labels(rankPalette(sources({ pages }), 'forecast operations'), 'pages')).toEqual([
      'Feeding › Forecast',
    ]);
  });

  it('matches the words of a name in any order, however they are spaced', () => {
    const people: PaletteRemoteSource = {
      status: 'ready',
      entries: [page('Fehmi Kaya'), page('Ada Lovelace')],
    };
    for (const query of ['kaya fehmi', 'fehmi  kaya', '  KAYA   fehmi ']) {
      expect(labels(rankPalette(sources({ people }), query), 'people')).toEqual(['Fehmi Kaya']);
    }
  });

  it('never matches the hint: it is what the row shows, not what it is found by', () => {
    // A person's hint is their online state: matching it would list every
    // online person for "on".
    const people: PaletteRemoteSource = {
      status: 'ready',
      entries: [page('Ada Lovelace', { hint: 'Online' }), page('Ali Veli', { hint: 'Offline' })],
    };
    expect(rankPalette(sources({ people }), 'online')).toEqual([]);
    expect(labels(rankPalette(sources({ people }), 'ali'), 'people')).toEqual(['Ali Veli']);
  });

  it('finds Norwegian names typed with base letters, and typed as written', () => {
    const people: PaletteRemoteSource = {
      status: 'ready',
      entries: [page('Bjørn Ærlig'), page('Ada Lovelace')],
    };
    expect(labels(rankPalette(sources({ people }), 'bjorn'), 'people')).toEqual(['Bjørn Ærlig']);
    expect(labels(rankPalette(sources({ people }), 'aerlig'), 'people')).toEqual(['Bjørn Ærlig']);
    expect(labels(rankPalette(sources({ people }), 'bjørn'), 'people')).toEqual(['Bjørn Ærlig']);
  });

  it('searches tabs as well as pages', () => {
    const pages = [page('Feeding'), page('Feeding › Forecast', { nested: true })];
    expect(labels(rankPalette(sources({ pages }), 'forecast'), 'pages')).toEqual([
      'Feeding › Forecast',
    ]);
  });

  it('caps pages at 6, people at 5, devices at 4 and keeps every matching command', () => {
    const many = (prefix: string, n: number): PaletteLinkEntry[] =>
      Array.from({ length: n }, (_, i) => page(`${prefix} ${i + 1}`));
    const result = rankPalette(
      sources({
        pages: many('Unit', 9),
        people: { status: 'ready', entries: many('Unit', 9) },
        devices: { status: 'ready', entries: many('Unit', 9) },
        commands: Array.from({ length: 9 }, (_, i) => command(`Unit ${i + 1}`)),
      }),
      'unit',
    );
    expect(PALETTE_GROUP_LIMITS).toEqual({ pages: 6, people: 5, devices: 4 });
    expect(labels(result, 'pages')).toHaveLength(6);
    expect(labels(result, 'people')).toHaveLength(5);
    expect(labels(result, 'devices')).toHaveLength(4);
    expect(labels(result, 'commands')).toHaveLength(9);
  });

  it('lists nothing from a fetched source that is not ready', () => {
    const result = rankPalette(
      sources({ people: { status: 'loading' }, devices: { status: 'error' } }),
      'ali',
    );
    expect(result).toEqual([]);
  });
});

describe('paletteNotices', () => {
  const pending = sources({ people: { status: 'loading' }, devices: { status: 'error' } });

  it('names the fetched sources still loading or failed while a query is typed', () => {
    expect(paletteNotices(pending, 'ali')).toEqual([
      { group: 'people', status: 'loading' },
      { group: 'devices', status: 'error' },
    ]);
  });

  it('is silent before anything is typed, and for sources this viewer cannot read', () => {
    expect(paletteNotices(pending, ' ')).toEqual([]);
    expect(paletteNotices(sources(), 'ali')).toEqual([]);
  });
});
