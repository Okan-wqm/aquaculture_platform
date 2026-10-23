import { readFileSync } from 'fs';
import { join } from 'path';

import { FIXTURES } from '../../../../../../tests/invariants/lib/suderra-edge-contract';
import { boardRow } from '../../edge-boards';
import {
  type AdmittedRelease,
  EdgeReleaseCatalog,
  type ReleaseProvenanceVerifier,
} from '../../edge-release-catalog.service';
import { type SuderraEdgeConfig } from '../../suderra-edge.config';
import { TrustAnchorBundleService } from '../../trust-anchor-bundle.service';

/**
 * The contract's release fixtures name a provenance digest no document can match,
 * so specs of statements and requests admit a fixture release with a verifier that
 * accepts the fixture's provenance. What the real verifier checks, and that the
 * catalog asks it, is proven against the release pipeline's own output in
 * edge-release-provenance.spec.ts.
 */
export const FIXTURE_PROVENANCE: ReleaseProvenanceVerifier = (_bytes, expected) => ({
  digestSha256: expected.digestSha256,
  repository: expected.repository,
  workflowRef: 'fixture',
  tag: `agent-v${expected.version}`,
  commit: '0'.repeat(40),
});

/** The release statement fixture of revpi-connect4 `version`, as the text the release host serves. */
export function fixtureReleaseText(version: string): string {
  return readFileSync(
    join(FIXTURES, `edge-release/valid/revpi-connect4-aarch64-${version}.dsse.json`),
    'utf8',
  );
}

/** A revpi-connect4 release of the contract's fixtures, admitted through the real catalog. */
export async function fixtureRelease(
  config: SuderraEdgeConfig,
  version = '1.7.0',
): Promise<AdmittedRelease> {
  const board = boardRow('revpi-connect4');
  if (board === null) throw new Error('boards.json has no revpi-connect4');
  const catalog = new EdgeReleaseCatalog(
    config,
    new TrustAnchorBundleService(config),
    async (url) =>
      url.endsWith('.intoto.jsonl') ? 'provenance fixture\n' : fixtureReleaseText(version),
    FIXTURE_PROVENANCE,
  );
  return catalog.forVersion(board, version);
}
