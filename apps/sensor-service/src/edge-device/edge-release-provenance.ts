import { createHash } from 'crypto';

import { StatementAdmissionError } from './manifest-signer';

/**
 * Release provenance admission (ADR-048 DEC-3.8, DEC-20): before any manifest
 * or update statement names a release, the cloud checks the in-toto SLSA
 * provenance the release pipeline published beside the artifact. A device never
 * reads provenance (the Ed25519 release statement is its trust); this is the
 * cloud's own check that the statement it is about to name describes an
 * artifact the expected repository's release workflow built from the tag.
 *
 * What is checked, against what the release statement already says:
 *
 *   - the file is the bytes the signed statement names (`provenance.digest`),
 *     exactly one in-toto statement line, as the pipeline writes it;
 *   - its subject is exactly the artifact, at the artifact's signed digest;
 *   - the build was run by the expected repository's release workflow, at the
 *     release's own tag, for the release's board, target and feature set;
 *   - the source it resolved is a git commit of that repository.
 *
 * What it cannot prove: the pipeline states the provenance itself in its
 * signing job (INFRA-MEDIUM-244), so this binds the artifact to the
 * repository, workflow, tag and commit the signing job reports, not to a
 * trusted builder's attestation. That strengthening is P2 (DEC-20), and this
 * module is where the builder identity check will be added.
 */

/** The workflow whose run produces and states a release (.github/workflows). */
export const EDGE_RELEASE_WORKFLOW_PATH = '.github/workflows/edge-agent-release.yml';

/** The release tag of an agent version (the workflow refuses any other form). */
export function releaseTag(version: string): string {
  return `agent-v${version}`;
}

export interface ProvenanceExpectation {
  /** `owner/repo` of the repository whose workflow publishes releases. */
  readonly repository: string;
  readonly version: string;
  readonly artifact: { readonly name: string; readonly sha256: string };
  readonly boardProfile: string;
  readonly rustTarget: string;
  /** The release statement's `cargo_features`. */
  readonly features: readonly string[];
  /** The release statement's `provenance.predicate_type`. */
  readonly predicateType: string;
  /** The release statement's `provenance.digest.sha256`. */
  readonly digestSha256: string;
}

/** What admission read out of a provenance document that checked out. */
export interface VerifiedProvenance {
  readonly digestSha256: string;
  readonly repository: string;
  readonly workflowRef: string;
  readonly tag: string;
  readonly commit: string;
}

const IN_TOTO_STATEMENT = 'https://in-toto.io/Statement/v1';
const COMMIT = /^[0-9a-f]{40}$/;
/** The channel the pipeline records for a Suderra OS artifact (edge_release.py CHANNEL_OS). */
const SUDERRA_OS_CHANNEL = 'suderra-os';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function member(owner: unknown, name: string): unknown {
  return isRecord(owner) ? owner[name] : undefined;
}

/** Verifies one provenance document; throws {@link StatementAdmissionError} naming the claim that failed. */
export function verifyReleaseProvenance(
  bytes: Buffer,
  expected: ProvenanceExpectation,
): VerifiedProvenance {
  const what = `The provenance of ${expected.artifact.name}`;
  function refuse(reason: string): never {
    throw new StatementAdmissionError(what, reason);
  }

  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== expected.digestSha256) {
    refuse('its digest is not the one the signed release statement names');
  }
  const text = bytes.toString('utf8');
  // One statement line, as the pipeline writes it: a trailing newline and no other.
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n') || text.length < 2) {
    refuse('it is not exactly one in-toto statement line');
  }
  let statement: unknown;
  try {
    statement = JSON.parse(text);
  } catch {
    refuse('it is not JSON');
  }
  if (member(statement, '_type') !== IN_TOTO_STATEMENT) {
    refuse('it is not an in-toto Statement v1');
  }
  if (member(statement, 'predicateType') !== expected.predicateType) {
    refuse('its predicate type is not the one the release statement names');
  }
  // The subject is the artifact and nothing else, at the digest the statement signs.
  const subject = member(statement, 'subject');
  const entry = Array.isArray(subject) && subject.length === 1 ? subject[0] : undefined;
  const entryDigest = member(entry, 'digest');
  const subjectOk =
    isRecord(entry) &&
    Object.keys(entry).length === 2 &&
    entry['name'] === expected.artifact.name &&
    isRecord(entryDigest) &&
    Object.keys(entryDigest).length === 1 &&
    entryDigest['sha256'] === expected.artifact.sha256;
  if (!subjectOk) {
    refuse('its subject is not exactly the artifact at the signed digest');
  }

  const build = member(member(statement, 'predicate'), 'buildDefinition');
  const parameters = member(build, 'externalParameters');
  const workflowRef = `${expected.repository}/${EDGE_RELEASE_WORKFLOW_PATH}@refs/tags/${releaseTag(expected.version)}`;
  if (member(parameters, 'repository') !== expected.repository) {
    refuse('it was built from another repository');
  }
  if (member(parameters, 'workflowRef') !== workflowRef) {
    refuse(`it was not built by ${workflowRef}`);
  }
  if (member(parameters, 'releaseTag') !== releaseTag(expected.version)) {
    refuse('it was built from another tag than the release version names');
  }
  if (member(parameters, 'channel') !== SUDERRA_OS_CHANNEL) {
    refuse('it is not the provenance of a Suderra OS artifact');
  }
  if (member(parameters, 'target') !== expected.boardProfile) {
    refuse('it was built for another board');
  }
  if (member(parameters, 'rustTarget') !== expected.rustTarget) {
    refuse('it was built for another Rust target');
  }
  if (member(parameters, 'features') !== [...expected.features].sort().join(',')) {
    refuse('it was built with another feature set than the release statement names');
  }

  const dependencies = member(build, 'resolvedDependencies');
  const commit = Array.isArray(dependencies)
    ? member(member(dependencies[0], 'digest'), 'gitCommit')
    : undefined;
  if (
    !Array.isArray(dependencies) ||
    dependencies.length !== 1 ||
    member(dependencies[0], 'uri') !== `git+https://github.com/${expected.repository}` ||
    typeof commit !== 'string' ||
    !COMMIT.test(commit)
  ) {
    refuse('it does not resolve exactly one git commit of the repository');
  }
  return {
    digestSha256: digest,
    repository: expected.repository,
    workflowRef,
    tag: releaseTag(expected.version),
    commit,
  };
}
