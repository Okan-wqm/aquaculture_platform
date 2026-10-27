/**
 * The build identity contract (FE-MEDIUM-380, PKG-42): each build — the shell and every remote —
 * names its id where the running tab reads it (the shell's index.html, a remote's entry module)
 * and in a served manifest beside it. Anything that is not a well-formed id reads as "unknown",
 * so a missing manifest, the edge's index.html fallback, a remote built before the id existed or
 * the dev server never makes a tab reload.
 */
import { describe, expect, it } from 'vitest';

import {
  BUILD_ID_META,
  BUILD_MANIFEST_FILE,
  REMOTE_BUILD_ID_EXPORT,
  buildIdFromManifest,
  buildIdOfDocument,
  buildIdOfRemoteEntry,
  buildManifestUrlBeside,
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
  it('names a manifest file, a meta tag for the shell and an export for a remote entry', () => {
    expect(BUILD_MANIFEST_FILE).toBe('build-manifest.json');
    expect(BUILD_ID_META).toBe('aqua-build-id');
    expect(REMOTE_BUILD_ID_EXPORT).toBe('aquaBuildId');
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

  it('reads the build id the loaded shell document carries', () => {
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

  it('reads the build id a loaded remote entry module exports', () => {
    const entry = Object.freeze({
      init: (): void => undefined,
      [REMOTE_BUILD_ID_EXPORT]: BUILD_ID,
    });
    expect(buildIdOfRemoteEntry(entry)).toBe(BUILD_ID);
  });

  it.each([
    ['an entry built before the id existed', { init: (): void => undefined }],
    ['a malformed id', { [REMOTE_BUILD_ID_EXPORT]: 'dev' }],
    ['no entry (a failed load)', undefined],
    ['a non-object', 'remoteEntry'],
  ])('reads %s as an unknown remote build', (_label, entry) => {
    expect(buildIdOfRemoteEntry(entry)).toBeNull();
  });

  it('finds a manifest beside the shell document and beside each remote entry', () => {
    const page = 'https://app.example/sites/tanks?view=list';
    expect(buildManifestUrlBeside('/', page)).toBe('https://app.example/build-manifest.json');
    expect(buildManifestUrlBeside('/remotes/farm-module/remoteEntry.js', page)).toBe(
      'https://app.example/remotes/farm-module/build-manifest.json',
    );
  });
});
