/**
 * deriveSheetCode — the title block's sheet code, read off the console nav ids
 * (design README §7.4: `area.slice(0,3)-page.slice(0,5)`, uppercase).
 *
 * The console's area ids carry their workspace as the first segment
 * (`aq-operations`, `ctl-control`), so that segment is the sheet's scope; the
 * page id's first segment gives up to five letters and every further segment
 * its initial — which is how the prototype spelled the feed-records sheet
 * (`AQ-FEED-R`).
 */
import { describe, expect, it } from 'vitest';

import { deriveSheetCode } from '../sheetCode';

describe('deriveSheetCode', () => {
  it('matches the README example: the area scope, then five letters of the page', () => {
    expect(deriveSheetCode({ areaId: 'aq-operations', pageId: 'environment' })).toBe('AQ-ENVIR');
  });

  it('keeps a short page id whole', () => {
    expect(deriveSheetCode({ areaId: 'aq-operations', pageId: 'tanks' })).toBe('AQ-TANKS');
    expect(deriveSheetCode({ areaId: 'gh-operations', pageId: 'ph' })).toBe('GH-PH');
  });

  it('adds the initial of every further page-id segment (the prototype feed-records sheet)', () => {
    expect(deriveSheetCode({ areaId: 'aq-operations', pageId: 'feed-records' })).toBe('AQ-FEED-R');
    expect(deriveSheetCode({ areaId: 'org-account', pageId: 'tenant-audit-log' })).toBe(
      'ORG-TENAN-A-L',
    );
  });

  it('caps the scope at three letters', () => {
    expect(deriveSheetCode({ areaId: 'ctl-control', pageId: 'devices' })).toBe('CTL-DEVIC');
    expect(deriveSheetCode({ areaId: 'aqua', pageId: 'environment' })).toBe('AQU-ENVIR');
  });

  it('reads any separator and case the same way', () => {
    expect(deriveSheetCode({ areaId: 'AQ_Operations', pageId: 'Feed Records' })).toBe('AQ-FEED-R');
  });

  it('returns null when an id has nothing to read, so the cell is not drawn', () => {
    expect(deriveSheetCode({ areaId: '', pageId: 'environment' })).toBeNull();
    expect(deriveSheetCode({ areaId: 'aq-operations', pageId: '--' })).toBeNull();
  });
});
