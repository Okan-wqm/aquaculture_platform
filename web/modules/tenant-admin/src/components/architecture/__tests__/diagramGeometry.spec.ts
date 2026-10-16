/**
 * diagramGeometry — orthogonal link routing for the architecture diagrams.
 *
 * The design document drew every diagram from data: links run from a point on
 * one box side to a point on another, with at most two bends, an arrowhead on
 * the last segment and the label centred on the run that carries it. These
 * tests pin that geometry so a ported diagram draws exactly what the design
 * drew.
 */
import { describe, expect, it } from 'vitest';

import { box, link } from '../content/platform/builders';
import { arrowHead, routeLink, routeSection } from '../diagramGeometry';
import type { ArchitectureSection } from '../types';

const a = box('a', 0, 0, 'A', { w: 100, h: 50 });
const b = box('b', 200, 0, 'B', { w: 100, h: 50 });
const c = box('c', 200, 100, 'C', { w: 100, h: 50 });
const byId = new Map([a, b, c].map((item) => [item.id, item]));

describe('routeLink', () => {
  it('runs one straight segment between level sides', () => {
    const routed = routeLink(link('a', 'b', ''), byId);
    expect(routed.points).toEqual([
      [100, 25],
      [200, 25],
    ]);
    expect(routed.path).toBe('M100.0 25.0L200.0 25.0');
  });

  it('bends twice, halfway across, between offset horizontal sides', () => {
    const routed = routeLink(link('a', 'c', ''), byId);
    expect(routed.points).toEqual([
      [100, 25],
      [150, 25],
      [150, 125],
      [200, 125],
    ]);
  });

  it('bends at a fixed x when the link sets mx', () => {
    const routed = routeLink(link('a', 'c', '', { mx: 120 }), byId);
    expect(routed.points[1]).toEqual([120, 25]);
    expect(routed.points[2]).toEqual([120, 125]);
  });

  it('bends at a fixed y between two vertical sides', () => {
    const routed = routeLink(link('a', 'c', '', { fs: 'b', ts: 't', my: 80 }), byId);
    expect(routed.points).toEqual([
      [50, 50],
      [50, 80],
      [250, 80],
      [250, 100],
    ]);
  });

  it('turns once from a horizontal side into a vertical one', () => {
    const routed = routeLink(link('a', 'c', '', { ts: 't' }), byId);
    expect(routed.points).toEqual([
      [100, 25],
      [250, 25],
      [250, 100],
    ]);
  });

  it('places the side points by fraction', () => {
    const routed = routeLink(link('a', 'b', '', { ff: 0.2, tf: 0.2 }), byId);
    expect(routed.points[0]).toEqual([100, 10]);
  });

  it('points the arrowhead along the last segment', () => {
    expect(routeLink(link('a', 'b', ''), byId).head).toBe(arrowHead(200, 25, 'r'));
    expect(routeLink(link('a', 'c', '', { ts: 't' }), byId).head).toBe(arrowHead(250, 100, 'd'));
  });

  it('fails loudly on a link to a box the section does not draw', () => {
    expect(() => routeLink(link('a', 'missing', ''), byId)).toThrow(/missing/);
  });
});

describe('arrowHead', () => {
  it('draws a closed 9 × 10 triangle behind the tip', () => {
    expect(arrowHead(200, 25, 'r')).toBe('M200 25L191 20L191 30Z');
    expect(arrowHead(250, 100, 'd')).toBe('M250 100L245 91L255 91Z');
  });
});

describe('link labels', () => {
  it('sits 14 units above the middle of a horizontal run', () => {
    const routed = routeLink(link('a', 'b', '1 : n'), byId);
    expect(routed.label).toEqual({ text: '1 : n', x: 150, y: 11, dated: false, kind: 'solid' });
  });

  it('sits on the middle segment of a two-bend link', () => {
    const routed = routeLink(link('a', 'c', 'x', { k: 'data' }), byId);
    expect(routed.label).toMatchObject({ x: 150, y: 75, kind: 'data' });
  });

  it('honours a fixed label position', () => {
    const routed = routeLink(link('a', 'b', 'x', { at: [10, 20] }), byId);
    expect(routed.label).toMatchObject({ x: 10, y: 20 });
  });

  it('marks a label that names a dated link', () => {
    expect(routeLink(link('a', 'b', 'takılı · tarihli'), byId).label?.dated).toBe(true);
  });

  it('draws no label for an unlabelled link', () => {
    expect(routeLink(link('a', 'b', ''), byId).label).toBeUndefined();
  });
});

describe('routeSection', () => {
  it('collects the links into one line path and one arrowhead path per kind', () => {
    const section: ArchitectureSection = {
      num: '99',
      title: 'T',
      intro: '',
      width: 400,
      height: 200,
      boxes: [a, b, c],
      links: [link('a', 'b', 'x'), link('a', 'c', '', { k: 'data', ts: 't' })],
      notes: [],
    };
    const routed = routeSection(section);
    expect(routed.layers.solid.line).toBe('M100.0 25.0L200.0 25.0');
    expect(routed.layers.data.heads).toBe(arrowHead(250, 100, 'd'));
    expect(routed.layers.assign.line).toBe('');
    expect(routed.labels.map((label) => label.text)).toEqual(['x']);
  });
});
