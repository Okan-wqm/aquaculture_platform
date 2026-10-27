/**
 * The build identity contract (FE-MEDIUM-380, PKG-42): the build writes its id into index.html
 * and into a served manifest; the open tab reads both. Anything that is not a well-formed id
 * reads as "unknown", so a missing manifest, the edge's index.html fallback or the dev server
 * never makes a tab reload.
 */
import { describe, expect, it } from 'vitest';

import {
  BUILD_ID_META,
  BUILD_MANIFEST_FILE,
  buildIdFromManifest,
  buildIdOfDocument,
  isBuildId,
} from '../buildManifest';

const BUILD_ID = 'a'.repeat(64);

function documentWith(head: string): Document {
  return new DOMParser().parseFromString(
    `<html><head>${head}</head><body></body></html>`,
    'text/html',
  );
}

describe('build identity contract', () => {
  it('names a manifest file at the root of the shell build and a meta tag in its document', () => {
    expect(BUILD_MANIFEST_FILE).toBe('build-manifest.json');
    expect(BUILD_ID_META).toBe('aqua-build-id');
  });

  it('accepts a sha-256 hex digest as a build id and nothing else', () => {
    expect(isBuildId(BUILD_ID)).toBe(true);
    expect(isBuildId('A'.repeat(64))).toBe(false);
    expect(isBuildId('a'.repeat(63))).toBe(false);
    expect(isBuildId('')).toBe(false);
    expect(isBuildId(42)).toBe(false);
    expect(isBuildId(null)).toBe(false);
  });

  it('reads the build id of a served manifest', () => {
    expect(buildIdFromManifest({ buildId: BUILD_ID })).toBe(BUILD_ID);
  });

  it.each([
    ['no manifest', null],
    ['an array', [BUILD_ID]],
    ['a manifest without an id', {}],
    ['a malformed id', { buildId: 'latest' }],
    ['the edge answering with index.html', '<!doctype html><html></html>'],
  ])('reads %s as an unknown build', (_label, manifest) => {
    expect(buildIdFromManifest(manifest)).toBeNull();
  });

  it('reads the build id the loaded document carries', () => {
    expect(
      buildIdOfDocument(documentWith(`<meta name="${BUILD_ID_META}" content="${BUILD_ID}">`)),
    ).toBe(BUILD_ID);
  });

  it('reads a document without the tag (the dev server) or with a malformed one as unknown', () => {
    expect(buildIdOfDocument(documentWith(''))).toBeNull();
    expect(
      buildIdOfDocument(documentWith(`<meta name="${BUILD_ID_META}" content="dev">`)),
    ).toBeNull();
  });
});
