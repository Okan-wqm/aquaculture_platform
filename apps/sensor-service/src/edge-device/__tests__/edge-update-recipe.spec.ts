import { parseRecipe, siteFilesOf } from '../edge-update-recipe';

/**
 * A recipe is stored as JSON and signed from after it is read back: the read admits
 * only a value shaped as the cloud wrote it (ADR-048 DEC-2.12).
 */

const TERMS = { localApproval: true, blockersOverride: false, maxOutageSeconds: 120 };
const BUNDLE = {
  version: '1.1.0',
  rollbackFloor: '1.0.0',
  minCurrentVersion: '1.0.0',
  supportedAgentAbi: '1-2',
  url: 'https://edge-releases.example.com/os/1.1.0/suderra-os-revpi-connect4-1.1.0.raucb',
  sha256: '33'.repeat(32),
  sizeBytes: 201326592,
};
const EDGE = { kind: 'edge-update', version: '1.7.0', terms: TERMS, windowSeconds: 7200 };
const OS = { kind: 'os-update', bundle: BUNDLE, terms: TERMS, windowSeconds: 7200 };

const POLICY = {
  interfaces: [{ role: 'ot', mac: '02:00:00:7e:57:02' }],
  ot_rules: [{ id: 'plc', proto: 'tcp', dst: '10.0.0.0/24', ports: [{ from: 502, to: 502 }] }],
  time_sources: [],
};
const SITE = {
  kind: 'site-config',
  files: { 'io-config.yaml': 'dGFnczogW10K' },
  windowSeconds: 7200,
};
const NET = { kind: 'site-netpolicy', policy: POLICY, windowSeconds: 3600 };
const ANCHORS = { kind: 'trust-anchors', bundleDigest: 'ab'.repeat(32), windowSeconds: 7200 };

describe('parseRecipe', () => {
  it('reads back what the cloud wrote, unchanged, after a JSON round trip', () => {
    for (const recipe of [EDGE, OS, SITE, NET, ANCHORS]) {
      expect(parseRecipe(JSON.parse(JSON.stringify(recipe)))).toEqual(recipe);
    }
  });

  it('decodes the operator files of a site-config recipe', () => {
    const recipe = parseRecipe(SITE);
    expect(recipe?.kind).toBe('site-config');
    if (recipe?.kind !== 'site-config') return;
    expect(siteFilesOf(recipe).get('io-config.yaml')?.toString('utf8')).toBe('tags: []\n');
  });

  it.each([
    ['not an object', 'edge-update'],
    ['an array', [EDGE]],
    ['null', null],
    ['an unknown kind', { ...EDGE, kind: 'site-config' }],
    ['no kind', { ...EDGE, kind: undefined }],
    ['a version that is not a path-safe semver', { ...EDGE, version: '../1.7.0' }],
    ['a version that is not a string', { ...EDGE, version: 17 }],
    ['no terms', { ...EDGE, terms: undefined }],
    ['terms with a non-boolean approval', { ...EDGE, terms: { ...TERMS, localApproval: 'yes' } }],
    ['terms with a fractional outage', { ...EDGE, terms: { ...TERMS, maxOutageSeconds: 1.5 } }],
    ['a window that is not whole seconds', { ...EDGE, windowSeconds: 7200.5 }],
    ['a window that is a string', { ...EDGE, windowSeconds: '7200' }],
    ['an os-update without its bundle', { ...OS, bundle: undefined }],
    ['an os-update bundle without a digest', { ...OS, bundle: { ...BUNDLE, sha256: undefined } }],
    [
      'an os-update bundle with a fractional size',
      { ...OS, bundle: { ...BUNDLE, sizeBytes: 1.5 } },
    ],
    [
      'a site-config with a file that is not a site path',
      { ...SITE, files: { 'etc/passwd': 'eA==' } },
    ],
    ['a site-config with a file that is not a string', { ...SITE, files: { 'io-config.yaml': 7 } }],
    ['a site-config without a window', { ...SITE, windowSeconds: undefined }],
    [
      'a site-netpolicy whose rule the contract refuses',
      {
        ...NET,
        policy: { ...POLICY, ot_rules: [{ id: 'X', proto: 'tcp', dst: '10.0.0.0/24', ports: [] }] },
      },
    ],
    ['a site-netpolicy with another member', { ...NET, policy: { ...POLICY, extra: [] } }],
    ['a site-netpolicy without a policy', { ...NET, policy: undefined }],
    ['a trust-anchors without the approved digest', { ...ANCHORS, bundleDigest: undefined }],
    ['a trust-anchors with a digest that is not sha256', { ...ANCHORS, bundleDigest: 'abc' }],
    ['a trust-anchors without its delivery bound', { ...ANCHORS, windowSeconds: undefined }],
  ])('refuses %s', (_name, value) => {
    expect(parseRecipe(value)).toBeNull();
  });
});
