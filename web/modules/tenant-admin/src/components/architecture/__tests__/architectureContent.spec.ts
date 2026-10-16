/**
 * The ported content of the two reference documents is complete and
 * self-consistent. WHY a content spec: the documents were copied from the
 * design files by hand-checked transformation, and a dropped finding, a link
 * to a box id that does not exist, or a scenario pointing at an anchor the
 * page never renders would pass every render test and only show up as a
 * missing arrow or a dead link. The counts are the design document's own.
 */
import { describe, expect, it } from 'vitest';

import {
  ARCHITECTURE_SECTIONS,
  CROSS_TOPICS,
  PRIORITIES,
  PROPOSED_FLOWS,
  PROPOSED_SECTIONS,
  REVIEW_SECTIONS,
  SCENARIOS,
} from '../content';
import { REVIEW_RENDERED_ANCHORS } from '../anchors';
import { countFindings, countScenarios } from '../reviewStats';

describe('Platform architecture v4 content', () => {
  it('has the fourteen sections, numbered in order', () => {
    expect(ARCHITECTURE_SECTIONS.map((section) => section.num)).toEqual([
      '01',
      '02',
      '03',
      '04',
      '05',
      '06',
      '07',
      '08',
      '09',
      '10',
      '11',
      '12',
      '13',
      '14',
    ]);
  });

  it.each(ARCHITECTURE_SECTIONS.map((section) => [section.num, section] as const))(
    '§%s links only boxes it draws, and draws each box id once',
    (_num, section) => {
      const ids = section.boxes.map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const item of section.links) {
        expect(ids).toContain(item.from);
        expect(ids).toContain(item.to);
      }
    },
  );

  it('carries an optional part (groups, rules, tables, flows) only when it has entries', () => {
    // The section view renders a part whenever it is present, so an empty one
    // would draw an empty "Kurallar" block or an empty table.
    for (const section of ARCHITECTURE_SECTIONS) {
      for (const part of [section.groups, section.rules, section.tables, section.flows]) {
        if (part !== undefined) expect(part.length).toBeGreaterThan(0);
      }
    }
  });

  it('carries the box and link counts of the design', () => {
    expect(ARCHITECTURE_SECTIONS.map((section) => section.boxes.length)).toEqual([
      11, 22, 15, 14, 10, 13, 10, 10, 10, 25, 10, 10, 10, 12,
    ]);
    const links = ARCHITECTURE_SECTIONS.reduce((sum, section) => sum + section.links.length, 0);
    expect(links).toBe(164);
  });

  it('keeps §08’s two report tables whole', () => {
    const tables = ARCHITECTURE_SECTIONS[7]?.tables ?? [];
    expect(tables.map((table) => table.rows.length)).toEqual([8, 9]);
    for (const table of tables) {
      for (const row of table.rows) expect(row).toHaveLength(table.cols.length);
    }
  });

  it('keeps §14’s 43-row flow table', () => {
    expect(ARCHITECTURE_SECTIONS[13]?.flows).toHaveLength(43);
  });
});

describe('Architecture review content', () => {
  it('reviews the eleven v3 sections with 64 findings of the four kinds', () => {
    expect(REVIEW_SECTIONS.map((section) => section.items.length)).toEqual([
      6, 7, 6, 8, 7, 7, 7, 6, 5, 2, 3,
    ]);
    expect(countFindings(REVIEW_SECTIONS)).toEqual({ total: 64, c: 10, b: 27, k: 21, u: 6 });
  });

  it('keeps the closing parts whole', () => {
    expect(PRIORITIES).toHaveLength(8);
    expect(CROSS_TOPICS).toHaveLength(10);
    expect(PROPOSED_SECTIONS).toHaveLength(3);
    expect(PROPOSED_FLOWS).toHaveLength(14);
    expect(SCENARIOS).toHaveLength(20);
    expect(countScenarios(SCENARIOS)).toEqual({ ok: 3, part: 8, no: 9 });
  });

  it('points every scenario and priority at a part the page renders', () => {
    const anchors = [...SCENARIOS.map((row) => row[4]), ...PRIORITIES.map((row) => row[3])];
    for (const anchor of anchors) expect(REVIEW_RENDERED_ANCHORS).toContain(anchor);
  });
});
