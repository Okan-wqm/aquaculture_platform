import { describe, it, expect } from 'vitest';
import {
  alignLeft,
  alignRight,
  alignTop,
  alignBottom,
  alignCenterH,
  alignCenterV,
  distributeH,
  distributeV,
  matchWidth,
  matchHeight,
  type WidgetRect,
} from '../alignmentUtils';

/* ------------------------------------------------------------------ */
/*  Helper                                                             */
/* ------------------------------------------------------------------ */

function makeWidget(
  id: string,
  col: number,
  row: number,
  w: number,
  h: number,
): WidgetRect {
  return { id, position: { col, row, w, h } };
}

/* ------------------------------------------------------------------ */
/*  alignLeft                                                          */
/* ------------------------------------------------------------------ */

describe('alignLeft', () => {
  it('aligns 3 widgets to the leftmost column', () => {
    const widgets = [
      makeWidget('a', 2, 0, 3, 2),
      makeWidget('b', 5, 0, 2, 3),
      makeWidget('c', 8, 0, 4, 1),
    ];
    const result = alignLeft(widgets);

    expect(result.size).toBe(3);
    expect(result.get('a')!.col).toBe(2);
    expect(result.get('b')!.col).toBe(2);
    expect(result.get('c')!.col).toBe(2);
  });

  it('preserves original sizes', () => {
    const widgets = [
      makeWidget('a', 2, 0, 3, 2),
      makeWidget('b', 5, 0, 2, 3),
      makeWidget('c', 8, 0, 4, 1),
    ];
    const result = alignLeft(widgets);

    expect(result.get('a')!.w).toBe(3);
    expect(result.get('a')!.h).toBe(2);
    expect(result.get('b')!.w).toBe(2);
    expect(result.get('b')!.h).toBe(3);
    expect(result.get('c')!.w).toBe(4);
    expect(result.get('c')!.h).toBe(1);
  });

  it('returns empty map for <2 widgets', () => {
    expect(alignLeft([]).size).toBe(0);
    expect(alignLeft([makeWidget('x', 3, 0, 2, 2)]).size).toBe(0);
  });

  it('clamps col to >= 0', () => {
    const widgets = [
      makeWidget('a', 0, 0, 2, 2),
      makeWidget('b', 5, 0, 2, 2),
    ];
    const result = alignLeft(widgets);
    expect(result.get('a')!.col).toBe(0);
    expect(result.get('b')!.col).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  alignRight                                                         */
/* ------------------------------------------------------------------ */

describe('alignRight', () => {
  it('aligns 3 widgets so right edges match the max right edge', () => {
    // Widget right edges: a=2+3=5, b=5+2=7, c=8+4=12  → maxRight=12
    const widgets = [
      makeWidget('a', 2, 0, 3, 2),
      makeWidget('b', 5, 0, 2, 3),
      makeWidget('c', 8, 0, 4, 1),
    ];
    const result = alignRight(widgets);

    expect(result.size).toBe(3);
    // a: col = 12 - 3 = 9
    expect(result.get('a')!.col).toBe(9);
    // b: col = 12 - 2 = 10
    expect(result.get('b')!.col).toBe(10);
    // c: col = 12 - 4 = 8 (unchanged)
    expect(result.get('c')!.col).toBe(8);
  });

  it('preserves sizes', () => {
    const widgets = [
      makeWidget('a', 0, 0, 1, 2),
      makeWidget('b', 3, 0, 5, 4),
    ];
    const result = alignRight(widgets);
    expect(result.get('a')!.w).toBe(1);
    expect(result.get('a')!.h).toBe(2);
    expect(result.get('b')!.w).toBe(5);
    expect(result.get('b')!.h).toBe(4);
  });

  it('returns empty map for <2 widgets', () => {
    expect(alignRight([]).size).toBe(0);
    expect(alignRight([makeWidget('x', 3, 0, 2, 2)]).size).toBe(0);
  });

  it('clamps col to >= 0', () => {
    // maxRight = 2, widget with w=5 → col = 2 - 5 = -3 → clamped to 0
    const widgets = [
      makeWidget('a', 0, 0, 2, 1),
      makeWidget('b', 0, 0, 5, 1),
    ];
    const result = alignRight(widgets);
    expect(result.get('b')!.col).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  alignTop                                                           */
/* ------------------------------------------------------------------ */

describe('alignTop', () => {
  it('aligns 3 widgets to the topmost row', () => {
    const widgets = [
      makeWidget('a', 0, 1, 2, 2),
      makeWidget('b', 0, 3, 2, 3),
      makeWidget('c', 0, 5, 2, 1),
    ];
    const result = alignTop(widgets);

    expect(result.size).toBe(3);
    expect(result.get('a')!.row).toBe(1);
    expect(result.get('b')!.row).toBe(1);
    expect(result.get('c')!.row).toBe(1);
  });

  it('preserves sizes and column positions', () => {
    const widgets = [
      makeWidget('a', 3, 1, 2, 2),
      makeWidget('b', 7, 5, 4, 3),
    ];
    const result = alignTop(widgets);
    expect(result.get('a')!.col).toBe(3);
    expect(result.get('a')!.w).toBe(2);
    expect(result.get('a')!.h).toBe(2);
    expect(result.get('b')!.col).toBe(7);
    expect(result.get('b')!.w).toBe(4);
    expect(result.get('b')!.h).toBe(3);
  });

  it('returns empty map for <2 widgets', () => {
    expect(alignTop([]).size).toBe(0);
    expect(alignTop([makeWidget('x', 0, 3, 2, 2)]).size).toBe(0);
  });

  it('clamps row to >= 0', () => {
    const widgets = [
      makeWidget('a', 0, 0, 2, 2),
      makeWidget('b', 0, 5, 2, 2),
    ];
    const result = alignTop(widgets);
    expect(result.get('a')!.row).toBe(0);
    expect(result.get('b')!.row).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  alignBottom                                                        */
/* ------------------------------------------------------------------ */

describe('alignBottom', () => {
  it('aligns 3 widgets so bottom edges match the max bottom edge', () => {
    // Bottom edges: a=1+2=3, b=3+3=6, c=5+1=6  → maxBottom=6
    const widgets = [
      makeWidget('a', 0, 1, 2, 2),
      makeWidget('b', 0, 3, 2, 3),
      makeWidget('c', 0, 5, 2, 1),
    ];
    const result = alignBottom(widgets);

    expect(result.size).toBe(3);
    // a: row = 6 - 2 = 4
    expect(result.get('a')!.row).toBe(4);
    // b: row = 6 - 3 = 3 (unchanged)
    expect(result.get('b')!.row).toBe(3);
    // c: row = 6 - 1 = 5 (unchanged)
    expect(result.get('c')!.row).toBe(5);
  });

  it('preserves sizes', () => {
    const widgets = [
      makeWidget('a', 0, 0, 3, 1),
      makeWidget('b', 0, 0, 2, 4),
    ];
    const result = alignBottom(widgets);
    expect(result.get('a')!.w).toBe(3);
    expect(result.get('a')!.h).toBe(1);
    expect(result.get('b')!.w).toBe(2);
    expect(result.get('b')!.h).toBe(4);
  });

  it('returns empty map for <2 widgets', () => {
    expect(alignBottom([]).size).toBe(0);
    expect(alignBottom([makeWidget('x', 0, 0, 2, 2)]).size).toBe(0);
  });

  it('clamps row to >= 0', () => {
    // maxBottom = 2, widget with h=5 → row = 2 - 5 = -3 → clamped to 0
    const widgets = [
      makeWidget('a', 0, 0, 1, 2),
      makeWidget('b', 0, 0, 1, 5),
    ];
    const result = alignBottom(widgets);
    expect(result.get('b')!.row).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  alignCenterH                                                       */
/* ------------------------------------------------------------------ */

describe('alignCenterH', () => {
  it('centers 3 widgets horizontally to the bounding box center', () => {
    // Bounding box: minCol=0, maxRight=0+4=4 for widest, but let's use clear example
    // widgets: a(col=0,w=2), b(col=4,w=4), c(col=10,w=2)
    // minCol=0, maxRight=10+2=12, center=6
    const widgets = [
      makeWidget('a', 0, 0, 2, 1),
      makeWidget('b', 4, 0, 4, 1),
      makeWidget('c', 10, 0, 2, 1),
    ];
    const result = alignCenterH(widgets);

    expect(result.size).toBe(3);
    // a: round(6 - 2/2) = round(5) = 5
    expect(result.get('a')!.col).toBe(5);
    // b: round(6 - 4/2) = round(4) = 4
    expect(result.get('b')!.col).toBe(4);
    // c: round(6 - 2/2) = round(5) = 5
    expect(result.get('c')!.col).toBe(5);
  });

  it('preserves sizes and row positions', () => {
    const widgets = [
      makeWidget('a', 0, 2, 3, 4),
      makeWidget('b', 6, 5, 2, 1),
    ];
    const result = alignCenterH(widgets);
    expect(result.get('a')!.row).toBe(2);
    expect(result.get('a')!.w).toBe(3);
    expect(result.get('a')!.h).toBe(4);
    expect(result.get('b')!.row).toBe(5);
    expect(result.get('b')!.w).toBe(2);
    expect(result.get('b')!.h).toBe(1);
  });

  it('returns empty map for <2 widgets', () => {
    expect(alignCenterH([]).size).toBe(0);
    expect(alignCenterH([makeWidget('x', 0, 0, 2, 2)]).size).toBe(0);
  });

  it('clamps col to >= 0', () => {
    // center = (0 + 1) / 2 = 0.5, widget w=4 → round(0.5 - 2) = round(-1.5) = -1 → clamped to 0
    const widgets = [
      makeWidget('a', 0, 0, 1, 1),
      makeWidget('b', 0, 0, 4, 1),
    ];
    const result = alignCenterH(widgets);
    expect(result.get('b')!.col).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------------------------ */
/*  alignCenterV                                                       */
/* ------------------------------------------------------------------ */

describe('alignCenterV', () => {
  it('centers 3 widgets vertically to the bounding box center', () => {
    // widgets: a(row=0,h=2), b(row=4,h=4), c(row=10,h=2)
    // minRow=0, maxBottom=10+2=12, center=6
    const widgets = [
      makeWidget('a', 0, 0, 1, 2),
      makeWidget('b', 0, 4, 1, 4),
      makeWidget('c', 0, 10, 1, 2),
    ];
    const result = alignCenterV(widgets);

    expect(result.size).toBe(3);
    // a: round(6 - 2/2) = round(5) = 5
    expect(result.get('a')!.row).toBe(5);
    // b: round(6 - 4/2) = round(4) = 4
    expect(result.get('b')!.row).toBe(4);
    // c: round(6 - 2/2) = round(5) = 5
    expect(result.get('c')!.row).toBe(5);
  });

  it('preserves sizes and column positions', () => {
    const widgets = [
      makeWidget('a', 3, 0, 2, 3),
      makeWidget('b', 7, 6, 4, 2),
    ];
    const result = alignCenterV(widgets);
    expect(result.get('a')!.col).toBe(3);
    expect(result.get('a')!.w).toBe(2);
    expect(result.get('a')!.h).toBe(3);
    expect(result.get('b')!.col).toBe(7);
    expect(result.get('b')!.w).toBe(4);
    expect(result.get('b')!.h).toBe(2);
  });

  it('returns empty map for <2 widgets', () => {
    expect(alignCenterV([]).size).toBe(0);
    expect(alignCenterV([makeWidget('x', 0, 0, 2, 2)]).size).toBe(0);
  });

  it('clamps row to >= 0', () => {
    // center = (0 + 1) / 2 = 0.5, widget h=4 → round(0.5 - 2) = round(-1.5) = -1 → clamped to 0
    const widgets = [
      makeWidget('a', 0, 0, 1, 1),
      makeWidget('b', 0, 0, 1, 4),
    ];
    const result = alignCenterV(widgets);
    expect(result.get('b')!.row).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------------------------ */
/*  distributeH                                                        */
/* ------------------------------------------------------------------ */

describe('distributeH', () => {
  it('distributes 4 widgets evenly horizontally, first and last stay in place', () => {
    // 4 widgets, each w=2, at cols 0, 3, 7, 18
    // After sort by col: [0, 3, 7, 18]
    // leftEdge=0, rightEdge=18+2=20
    // totalWidgetWidth = 2*4 = 8, totalGap = 20 - 0 - 8 = 12, gapBetween = 12/3 = 4
    // positions: 0, 0+2+4=6, 6+2+4=12, last stays at 18
    const widgets = [
      makeWidget('a', 0, 0, 2, 1),
      makeWidget('b', 3, 0, 2, 1),
      makeWidget('c', 7, 0, 2, 1),
      makeWidget('d', 18, 0, 2, 1),
    ];
    const result = distributeH(widgets);

    expect(result.size).toBe(4);
    // First stays
    expect(result.get('a')!.col).toBe(0);
    // Middle widgets distributed
    expect(result.get('b')!.col).toBe(6);
    expect(result.get('c')!.col).toBe(12);
    // Last stays
    expect(result.get('d')!.col).toBe(18);
  });

  it('handles widgets with different widths', () => {
    // widgets at cols 0(w=1), 2(w=3), 10(w=2), 20(w=4)
    // sorted: [0, 2, 10, 20]
    // leftEdge=0, rightEdge=20+4=24
    // totalWidgetWidth=1+3+2+4=10, totalGap=24-0-10=14, gapBetween=14/3≈4.667
    // currentCol tracking (cumulative):
    //   i=0: stays at 0, currentCol = 0 + 1 + 4.667 = 5.667
    //   i=1: round(5.667)=6, currentCol = 5.667 + 3 + 4.667 = 13.333
    //   i=2: round(13.333)=13, last stays at 20
    const widgets = [
      makeWidget('a', 0, 0, 1, 1),
      makeWidget('b', 2, 0, 3, 1),
      makeWidget('c', 10, 0, 2, 1),
      makeWidget('d', 20, 0, 4, 1),
    ];
    const result = distributeH(widgets);

    expect(result.size).toBe(4);
    expect(result.get('a')!.col).toBe(0);
    expect(result.get('b')!.col).toBe(6);
    expect(result.get('c')!.col).toBe(13);
    expect(result.get('d')!.col).toBe(20);
  });

  it('returns empty map for <3 widgets', () => {
    expect(distributeH([]).size).toBe(0);
    expect(distributeH([makeWidget('x', 0, 0, 2, 2)]).size).toBe(0);
    expect(
      distributeH([
        makeWidget('a', 0, 0, 2, 2),
        makeWidget('b', 5, 0, 2, 2),
      ]).size,
    ).toBe(0);
  });

  it('preserves row positions and sizes', () => {
    const widgets = [
      makeWidget('a', 0, 1, 2, 3),
      makeWidget('b', 5, 4, 2, 5),
      makeWidget('c', 10, 7, 2, 1),
    ];
    const result = distributeH(widgets);
    expect(result.get('a')!.row).toBe(1);
    expect(result.get('a')!.h).toBe(3);
    expect(result.get('b')!.row).toBe(4);
    expect(result.get('b')!.h).toBe(5);
    expect(result.get('c')!.row).toBe(7);
    expect(result.get('c')!.h).toBe(1);
  });

  it('clamps col to >= 0', () => {
    // All widgets at col=0 → gap is negative → middle widget stays clamped at 0
    const widgets = [
      makeWidget('a', 0, 0, 5, 1),
      makeWidget('b', 0, 0, 5, 1),
      makeWidget('c', 0, 0, 5, 1),
    ];
    const result = distributeH(widgets);
    for (const [, pos] of result) {
      expect(pos.col).toBeGreaterThanOrEqual(0);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  distributeV                                                        */
/* ------------------------------------------------------------------ */

describe('distributeV', () => {
  it('distributes 4 widgets evenly vertically, first and last stay in place', () => {
    // 4 widgets, each h=2, at rows 0, 4, 8, 18
    // After sort by row: [0, 4, 8, 18]
    // topEdge=0, bottomEdge=18+2=20
    // totalWidgetHeight = 2*4 = 8, totalGap = 20 - 0 - 8 = 12, gapBetween = 12/3 = 4
    // positions: 0, 0+2+4=6, 6+2+4=12, last stays at 18
    const widgets = [
      makeWidget('a', 0, 0, 1, 2),
      makeWidget('b', 0, 4, 1, 2),
      makeWidget('c', 0, 8, 1, 2),
      makeWidget('d', 0, 18, 1, 2),
    ];
    const result = distributeV(widgets);

    expect(result.size).toBe(4);
    expect(result.get('a')!.row).toBe(0);
    expect(result.get('b')!.row).toBe(6);
    expect(result.get('c')!.row).toBe(12);
    expect(result.get('d')!.row).toBe(18);
  });

  it('handles widgets with different heights', () => {
    // widgets at rows 0(h=1), 2(h=3), 10(h=2), 20(h=4)
    // sorted: [0, 2, 10, 20]
    // topEdge=0, bottomEdge=20+4=24
    // totalWidgetHeight=1+3+2+4=10, totalGap=24-0-10=14, gapBetween=14/3≈4.667
    // currentRow tracking (cumulative):
    //   i=0: stays at 0, currentRow = 0 + 1 + 4.667 = 5.667
    //   i=1: round(5.667)=6, currentRow = 5.667 + 3 + 4.667 = 13.333
    //   i=2: round(13.333)=13, last stays at 20
    const widgets = [
      makeWidget('a', 0, 0, 1, 1),
      makeWidget('b', 0, 2, 1, 3),
      makeWidget('c', 0, 10, 1, 2),
      makeWidget('d', 0, 20, 1, 4),
    ];
    const result = distributeV(widgets);

    expect(result.size).toBe(4);
    expect(result.get('a')!.row).toBe(0);
    expect(result.get('b')!.row).toBe(6);
    expect(result.get('c')!.row).toBe(13);
    expect(result.get('d')!.row).toBe(20);
  });

  it('returns empty map for <3 widgets', () => {
    expect(distributeV([]).size).toBe(0);
    expect(distributeV([makeWidget('x', 0, 0, 2, 2)]).size).toBe(0);
    expect(
      distributeV([
        makeWidget('a', 0, 0, 2, 2),
        makeWidget('b', 0, 5, 2, 2),
      ]).size,
    ).toBe(0);
  });

  it('preserves column positions and sizes', () => {
    const widgets = [
      makeWidget('a', 1, 0, 3, 2),
      makeWidget('b', 4, 5, 5, 2),
      makeWidget('c', 7, 10, 1, 2),
    ];
    const result = distributeV(widgets);
    expect(result.get('a')!.col).toBe(1);
    expect(result.get('a')!.w).toBe(3);
    expect(result.get('b')!.col).toBe(4);
    expect(result.get('b')!.w).toBe(5);
    expect(result.get('c')!.col).toBe(7);
    expect(result.get('c')!.w).toBe(1);
  });

  it('clamps row to >= 0', () => {
    const widgets = [
      makeWidget('a', 0, 0, 1, 5),
      makeWidget('b', 0, 0, 1, 5),
      makeWidget('c', 0, 0, 1, 5),
    ];
    const result = distributeV(widgets);
    for (const [, pos] of result) {
      expect(pos.row).toBeGreaterThanOrEqual(0);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  matchWidth                                                         */
/* ------------------------------------------------------------------ */

describe('matchWidth', () => {
  it('matches all widgets to the maximum width', () => {
    const widgets = [
      makeWidget('a', 0, 0, 2, 1),
      makeWidget('b', 0, 0, 3, 1),
      makeWidget('c', 0, 0, 4, 1),
    ];
    const result = matchWidth(widgets);

    expect(result.size).toBe(3);
    expect(result.get('a')!.w).toBe(4);
    expect(result.get('b')!.w).toBe(4);
    expect(result.get('c')!.w).toBe(4);
  });

  it('preserves positions and heights', () => {
    const widgets = [
      makeWidget('a', 1, 2, 2, 5),
      makeWidget('b', 3, 4, 3, 6),
      makeWidget('c', 5, 6, 4, 7),
    ];
    const result = matchWidth(widgets);
    expect(result.get('a')!.col).toBe(1);
    expect(result.get('a')!.row).toBe(2);
    expect(result.get('a')!.h).toBe(5);
    expect(result.get('b')!.col).toBe(3);
    expect(result.get('b')!.row).toBe(4);
    expect(result.get('b')!.h).toBe(6);
    expect(result.get('c')!.col).toBe(5);
    expect(result.get('c')!.row).toBe(6);
    expect(result.get('c')!.h).toBe(7);
  });

  it('returns empty map for <2 widgets', () => {
    expect(matchWidth([]).size).toBe(0);
    expect(matchWidth([makeWidget('x', 0, 0, 3, 3)]).size).toBe(0);
  });

  it('handles all widgets already the same width', () => {
    const widgets = [
      makeWidget('a', 0, 0, 5, 1),
      makeWidget('b', 0, 0, 5, 1),
    ];
    const result = matchWidth(widgets);
    expect(result.get('a')!.w).toBe(5);
    expect(result.get('b')!.w).toBe(5);
  });
});

/* ------------------------------------------------------------------ */
/*  matchHeight                                                        */
/* ------------------------------------------------------------------ */

describe('matchHeight', () => {
  it('matches all widgets to the maximum height', () => {
    const widgets = [
      makeWidget('a', 0, 0, 1, 1),
      makeWidget('b', 0, 0, 1, 2),
      makeWidget('c', 0, 0, 1, 3),
    ];
    const result = matchHeight(widgets);

    expect(result.size).toBe(3);
    expect(result.get('a')!.h).toBe(3);
    expect(result.get('b')!.h).toBe(3);
    expect(result.get('c')!.h).toBe(3);
  });

  it('preserves positions and widths', () => {
    const widgets = [
      makeWidget('a', 1, 2, 5, 1),
      makeWidget('b', 3, 4, 6, 2),
      makeWidget('c', 5, 6, 7, 3),
    ];
    const result = matchHeight(widgets);
    expect(result.get('a')!.col).toBe(1);
    expect(result.get('a')!.row).toBe(2);
    expect(result.get('a')!.w).toBe(5);
    expect(result.get('b')!.col).toBe(3);
    expect(result.get('b')!.row).toBe(4);
    expect(result.get('b')!.w).toBe(6);
    expect(result.get('c')!.col).toBe(5);
    expect(result.get('c')!.row).toBe(6);
    expect(result.get('c')!.w).toBe(7);
  });

  it('returns empty map for <2 widgets', () => {
    expect(matchHeight([]).size).toBe(0);
    expect(matchHeight([makeWidget('x', 0, 0, 3, 3)]).size).toBe(0);
  });

  it('handles all widgets already the same height', () => {
    const widgets = [
      makeWidget('a', 0, 0, 1, 4),
      makeWidget('b', 0, 0, 1, 4),
    ];
    const result = matchHeight(widgets);
    expect(result.get('a')!.h).toBe(4);
    expect(result.get('b')!.h).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/*  General edge cases                                                 */
/* ------------------------------------------------------------------ */

describe('general edge cases', () => {
  it('does not mutate the original widget positions', () => {
    const widgets = [
      makeWidget('a', 2, 3, 4, 5),
      makeWidget('b', 8, 9, 1, 2),
    ];
    const originalA = { ...widgets[0].position };
    const originalB = { ...widgets[1].position };

    alignLeft(widgets);
    alignRight(widgets);
    alignTop(widgets);
    alignBottom(widgets);
    alignCenterH(widgets);
    alignCenterV(widgets);
    matchWidth(widgets);
    matchHeight(widgets);

    expect(widgets[0].position).toEqual(originalA);
    expect(widgets[1].position).toEqual(originalB);
  });

  it('distribute does not mutate original positions', () => {
    const widgets = [
      makeWidget('a', 0, 0, 2, 2),
      makeWidget('b', 5, 5, 2, 2),
      makeWidget('c', 10, 10, 2, 2),
    ];
    const originals = widgets.map((w) => ({ ...w.position }));

    distributeH(widgets);
    distributeV(widgets);

    widgets.forEach((w, i) => {
      expect(w.position).toEqual(originals[i]);
    });
  });
});
