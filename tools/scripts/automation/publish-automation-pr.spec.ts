import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  automationPublicationBranch,
  resolveAutomationPublicationPolicy,
  type ResolvedAutomationPublicationPolicy,
} from '../../gates/lib/automation-publication-policy';

import {
  AUTOMATION_PUBLICATION_NETWORK_BUDGET,
  AutomationPublisher,
  GitHubAutomationPublicationRemote,
  GitHubApiError,
  PublicationFailure,
  assertAutomationPublicationInputDigest,
  automationPublicationFailureResult,
  automationPublicationRetryIdentity,
  finalizeAutomationPublication,
  publicationRequestFromEnvironment,
  readImmutableFileSnapshot,
  rethrowPublicationWriteErrors,
  writeExclusiveDurableResult,
  writeGitHubOutputs,
  type GitHubAutomationPublicationTransport,
  type AutomationPublicationRemote,
  type AutomationPublicationRequest,
  type CreatedCommit,
  type JsonRecord,
  type RemoteCommitEvidence,
  type RemotePullRequest,
  type RemotePullRequestSummary,
} from './publish-automation-pr';

const BASE_SHA = '1'.repeat(40);
const CREATED_SHA = '2'.repeat(40);
const STALE_SHA = '3'.repeat(40);
const MERGE_SHA = '4'.repeat(40);
const ADVANCED_MAIN_SHA = '5'.repeat(40);
const INPUT_SHA256 = 'a'.repeat(64);
const EVIDENCE_SHA256 = 'b'.repeat(64);
const REGISTRY_PATH = 'docs/reviews/_registry/findings.jsonl';
const REGISTRY_WORKFLOW_REF =
  'Okan-wqm/aquaculture_platform/.github/workflows/finding-registry-authority.yml@refs/heads/main';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlobOid(bytes: Buffer): string {
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`, 'utf8')
    .update(bytes)
    .digest('hex');
}

function registryPolicy(): ResolvedAutomationPublicationPolicy {
  return resolveAutomationPublicationPolicy({
    operation: 'add',
    commandId: 'finding-request:TEST-HIGH-001',
    baseSha: BASE_SHA,
    workflowRef: REGISTRY_WORKFLOW_REF,
    branch: 'automation/finding-registry-active',
    changedPath: REGISTRY_PATH,
    commitHeadline: 'chore(findings): canonical add mutation',
    pullRequestTitle: 'chore(findings): canonical add mutation',
  });
}

function publicationRequest(
  overrides: Partial<AutomationPublicationRequest> = {},
): AutomationPublicationRequest {
  const bytes = Buffer.from('{"finding_id":"TEST-HIGH-001"}\n', 'utf8');
  const policy = registryPolicy();
  const workflowRunId = overrides.workflowRunId ?? 9001;
  const workflowRunAttempt = overrides.workflowRunAttempt ?? 1;
  return {
    policy,
    repositoryRoot: '/repo',
    baseSha: BASE_SHA,
    commandId: 'finding-request:TEST-HIGH-001',
    operation: 'add',
    inputSha256: INPUT_SHA256,
    changedFile: {
      path: REGISTRY_PATH,
      bytes,
      sha256: sha256(bytes),
      gitBlobOid: gitBlobOid(bytes),
    },
    pullRequestBody: 'Canonical finding registry mutation.',
    pullRequestBodySha256: sha256('Canonical finding registry mutation.'),
    workflowRef: REGISTRY_WORKFLOW_REF,
    workflowSha: BASE_SHA,
    workflowEvent: 'workflow_dispatch',
    workflowRunId,
    workflowRunAttempt,
    appSlug: 'aqua-automation',
    appInstallationId: 1234,
    evidence: {
      artifactId: workflowRunId,
      artifactName: `finding-registry-authority-input-${String(workflowRunId)}-${String(
        workflowRunAttempt,
      )}`,
      artifactSha256: EVIDENCE_SHA256,
    },
    ...overrides,
  };
}

type RaceMode =
  | 'none'
  | 'branch-422'
  | 'commit-response-loss'
  | 'pull-request-422'
  | 'pull-request-response-loss'
  | 'pull-request-verification-failure';

class FakePublicationRemote implements AutomationPublicationRemote {
  private readonly branches = new Map<string, string>([['main', BASE_SHA]]);
  private readonly commits = new Map<string, RemoteCommitEvidence>();
  private readonly pullRequests = new Map<number, RemotePullRequest>();
  private nextPullRequestNumber = 1;
  private baseBlobOid: string | null = null;

  public raceMode: RaceMode = 'none';
  public pullRequestAuthorLogin = 'aqua-automation[bot]';
  public pullRequestDraft = false;
  public failPullRequestReads = false;
  public readonly events: string[] = [];

  public setBaseBlob(oid: string | null): void {
    this.baseBlobOid = oid;
  }

  public mutatePullRequest(number: number, updates: Partial<RemotePullRequest>): void {
    const current = this.pullRequests.get(number);
    if (!current) throw new Error(`Unknown fake pull request: ${String(number)}`);
    this.pullRequests.set(number, { ...current, ...updates });
  }

  public seedBranch(branch: string, oid: string): void {
    this.branches.set(branch, oid);
  }

  public setMainSha(sha: string): void {
    this.branches.set('main', sha);
  }

  public peekBranch(branch: string): string | null {
    return this.branches.get(branch) ?? null;
  }

  public simulateMergedBranchRemoval(branch: string): void {
    this.branches.delete(branch);
  }

  public seedForeignPublicationBranch(request: AutomationPublicationRequest): void {
    const branch = automationPublicationBranch(request.policy, request.commandId);
    this.branches.set(branch, STALE_SHA);
    this.commits.set(STALE_SHA, {
      sha: STALE_SHA,
      message: 'foreign stale automation commit',
      parentShas: ['9'.repeat(40)],
      signatureValid: true,
      signatureReason: 'valid',
      signatureWasSignedByGitHub: true,
      signatureState: 'VALID',
      authorLogin: `${request.appSlug}[bot]`,
      changedPaths: [request.changedFile.path],
      changedBlobOid: request.changedFile.gitBlobOid,
    });
  }

  public assertInstallationIdentity(
    expectedAppSlug: string,
    expectedInstallationId: number,
  ): Promise<void> {
    assert.equal(expectedAppSlug, 'aqua-automation');
    assert.equal(expectedInstallationId, 1234);
    this.events.push('installation');
    return Promise.resolve();
  }

  public getBranchOid(branch: string): Promise<string | null> {
    this.events.push(`read-branch:${branch}`);
    return Promise.resolve(this.branches.get(branch) ?? null);
  }

  public getFileBlobOid(path: string, ref: string): Promise<string | null> {
    assert.equal(path, REGISTRY_PATH);
    assert.equal(ref, BASE_SHA);
    this.events.push('read-base-blob');
    return Promise.resolve(this.baseBlobOid);
  }

  public getCommit(sha: string, changedPath: string): Promise<RemoteCommitEvidence> {
    assert.equal(changedPath, REGISTRY_PATH);
    this.events.push(`read-commit:${sha}`);
    const commit = this.commits.get(sha);
    if (!commit) throw new Error(`Unknown fake commit: ${sha}`);
    return Promise.resolve(commit);
  }

  public listPullRequests(branch: string): Promise<readonly RemotePullRequestSummary[]> {
    this.events.push(`list-prs:${branch}`);
    return Promise.resolve(
      [...this.pullRequests.values()]
        .filter((pullRequest) => pullRequest.headRef === branch)
        .map((pullRequest) => ({
          number: pullRequest.number,
          headSha: pullRequest.headSha,
          title: pullRequest.title,
          body: pullRequest.body,
        })),
    );
  }

  public getPullRequest(number: number): Promise<RemotePullRequest> {
    this.events.push(`read-pr:${String(number)}`);
    if (this.failPullRequestReads) {
      throw new Error('simulated post-create PR revalidation failure');
    }
    const pullRequest = this.pullRequests.get(number);
    if (!pullRequest) throw new Error(`Unknown fake pull request: ${String(number)}`);
    return Promise.resolve(pullRequest);
  }

  public isCommitReachableFrom(commitSha: string, mainSha: string): Promise<boolean> {
    this.events.push(`reachable:${commitSha}:${mainSha}`);
    return Promise.resolve(
      commitSha === MERGE_SHA && (mainSha === BASE_SHA || mainSha === ADVANCED_MAIN_SHA),
    );
  }

  public createBranch(branch: string, sha: string): Promise<void> {
    this.events.push(`create-branch:${branch}:${sha}`);
    if (this.branches.has(branch)) throw new GitHubApiError(422, 'branch exists');
    this.branches.set(branch, sha);
    if (this.raceMode === 'branch-422') {
      throw new GitHubApiError(422, 'competing branch creator won');
    }
    return Promise.resolve();
  }

  public createCommit(input: {
    readonly branch: string;
    readonly expectedHeadOid: string;
    readonly headline: string;
    readonly body: string;
    readonly path: string;
    readonly contentsBase64: string;
    readonly clientMutationId: string;
  }): Promise<CreatedCommit> {
    this.events.push(`create-commit:${input.expectedHeadOid}`);
    assert.equal(this.branches.get(input.branch), input.expectedHeadOid);
    assert.equal(input.expectedHeadOid, BASE_SHA);
    assert.equal(input.path, REGISTRY_PATH);
    const changedBytes = Buffer.from(input.contentsBase64, 'base64');
    const commit: RemoteCommitEvidence = {
      sha: CREATED_SHA,
      message: `${input.headline}\n\n${input.body}`,
      parentShas: [input.expectedHeadOid],
      signatureValid: true,
      signatureReason: 'valid',
      signatureWasSignedByGitHub: true,
      signatureState: 'VALID',
      authorLogin: 'aqua-automation[bot]',
      changedPaths: [input.path],
      changedBlobOid: gitBlobOid(changedBytes),
    };
    this.commits.set(CREATED_SHA, commit);
    this.branches.set(input.branch, CREATED_SHA);
    if (this.raceMode === 'commit-response-loss') {
      throw new Error('simulated GraphQL response loss');
    }
    return Promise.resolve({
      oid: CREATED_SHA,
      refOid: CREATED_SHA,
      clientMutationId: input.clientMutationId,
      signatureValid: true,
      wasSignedByGitHub: true,
      signatureState: 'VALID',
    });
  }

  public createPullRequest(input: {
    readonly branch: string;
    readonly title: string;
    readonly body: string;
  }): Promise<RemotePullRequest> {
    this.events.push(`create-pr:${input.branch}`);
    const headSha = this.branches.get(input.branch);
    if (!headSha) throw new Error('Cannot create a fake PR without a head branch');
    const number = this.nextPullRequestNumber;
    this.nextPullRequestNumber += 1;
    const pullRequest: RemotePullRequest = {
      number,
      url: `https://github.com/Okan-wqm/aquaculture_platform/pull/${String(number)}`,
      state: 'OPEN',
      merged: false,
      mergeCommitSha: null,
      baseRef: 'main',
      baseSha: BASE_SHA,
      headRef: input.branch,
      headSha,
      headRepository: 'Okan-wqm/aquaculture_platform',
      authorLogin: this.pullRequestAuthorLogin,
      draft: this.pullRequestDraft,
      title: input.title,
      body: input.body,
    };
    this.pullRequests.set(number, pullRequest);
    if (this.raceMode === 'pull-request-verification-failure') {
      this.failPullRequestReads = true;
      throw new PublicationFailure('simulated post-create PR revalidation failure', {
        stage: 'PULL_REQUEST_CREATED',
        retryIdentity: null,
        observedBranchSha: headSha,
        commitSha: headSha,
        pullRequestNumber: number,
        pullRequestUrl: pullRequest.url,
      });
    }
    if (this.raceMode === 'pull-request-422') {
      throw new GitHubApiError(422, 'competing PR creator won');
    }
    if (this.raceMode === 'pull-request-response-loss') {
      throw new Error('simulated pull request response loss');
    }
    return Promise.resolve(pullRequest);
  }
}

void describe('automation publication retry and remote reconciliation', () => {
  void it('rejects a forged request snapshot before any remote call', async () => {
    const request = publicationRequest();
    const remote = new FakePublicationRemote();

    await assert.rejects(
      new AutomationPublisher(remote).publish({
        ...request,
        changedFile: {
          ...request.changedFile,
          sha256: 'f'.repeat(64),
        },
      }),
      /snapshot hashes differ/,
    );
    assert.deepEqual(remote.events, []);
  });

  void it('keeps one retry identity across run, attempt, and evidence provenance changes', async () => {
    const firstRequest = publicationRequest();
    const retryRequest = publicationRequest({
      workflowRunId: 9100,
      workflowRunAttempt: 3,
      evidence: {
        artifactId: 55,
        artifactName: 'finding-registry-authority-input-9100-3',
        artifactSha256: 'c'.repeat(64),
      },
    });
    assert.equal(
      automationPublicationRetryIdentity(firstRequest),
      automationPublicationRetryIdentity(retryRequest),
    );

    const remote = new FakePublicationRemote();
    const publisher = new AutomationPublisher(remote);
    const first = await publisher.publish(firstRequest);
    const recovered = await publisher.publish(retryRequest);

    assert.equal(first.status, 'PUBLISHED');
    assert.equal(recovered.status, 'RECOVERED');
    assert.equal(recovered.commit_sha, first.commit_sha);
    assert.equal(recovered.pr_number, first.pr_number);
    assert.equal(recovered.retry_identity, first.retry_identity);
  });

  void it('fences one command to one branch and fails closed on cross-run semantic drift', async () => {
    const firstRequest = publicationRequest();
    const driftedBody = 'A reused command attempted different publication semantics.';
    const driftedRequest = publicationRequest({
      baseSha: ADVANCED_MAIN_SHA,
      workflowSha: ADVANCED_MAIN_SHA,
      inputSha256: 'd'.repeat(64),
      pullRequestBody: driftedBody,
      pullRequestBodySha256: sha256(driftedBody),
      workflowRunId: 9200,
      workflowRunAttempt: 1,
      evidence: {
        artifactId: 9200,
        artifactName: 'finding-registry-authority-input-9200-1',
        artifactSha256: 'e'.repeat(64),
      },
    });
    assert.notEqual(
      automationPublicationRetryIdentity(firstRequest),
      automationPublicationRetryIdentity(driftedRequest),
    );
    assert.equal(
      automationPublicationBranch(firstRequest.policy, firstRequest.commandId),
      automationPublicationBranch(driftedRequest.policy, driftedRequest.commandId),
    );

    const remote = new FakePublicationRemote();
    const publisher = new AutomationPublisher(remote);
    await publisher.publish(firstRequest);
    remote.setMainSha(ADVANCED_MAIN_SHA);

    await assert.rejects(
      publisher.publish(driftedRequest),
      /stable publication|differs|provenance|noncanonical/i,
    );
    assert.equal(remote.events.filter((event) => event.startsWith('create-branch:')).length, 1);
    assert.equal(remote.events.filter((event) => event.startsWith('create-pr:')).length, 1);
  });

  for (const raceMode of [
    'branch-422',
    'commit-response-loss',
    'pull-request-422',
    'pull-request-response-loss',
  ] as const) {
    void it(`recovers the stable publication after ${raceMode}`, async () => {
      const remote = new FakePublicationRemote();
      remote.raceMode = raceMode;
      const result = await new AutomationPublisher(remote).publish(publicationRequest());

      assert.equal(result.status, 'RECOVERED');
      assert.equal(result.commit_sha, CREATED_SHA);
      assert.equal(result.pr_number, 1);
      assert.equal(remote.events.filter((event) => event.startsWith('create-pr:')).length, 1);
    });
  }

  void it('uses a command-identity immutable branch and leaves a legacy shared ref untouched', async () => {
    const request = publicationRequest();
    const remote = new FakePublicationRemote();
    remote.seedBranch(request.policy.branch, STALE_SHA);
    const branch = automationPublicationBranch(request.policy, request.commandId);

    const result = await new AutomationPublisher(remote).publish(request);

    assert.equal(result.status, 'PUBLISHED');
    assert.equal(result.branch, branch);
    assert.equal(remote.peekBranch(request.policy.branch), STALE_SHA);
    assert.equal(remote.events.includes(`read-branch:${request.policy.branch}`), false);
    assert.ok(remote.events.includes(`create-branch:${branch}:${BASE_SHA}`));
  });

  void it('isolates distinct command identities instead of serializing them through one branch', async () => {
    const firstRequest = publicationRequest();
    const secondRequest = publicationRequest({
      commandId: 'finding-request:TEST-HIGH-002',
    });
    const remote = new FakePublicationRemote();
    const publisher = new AutomationPublisher(remote);

    const first = await publisher.publish(firstRequest);
    const second = await publisher.publish(secondRequest);

    assert.equal(first.status, 'PUBLISHED');
    assert.equal(second.status, 'PUBLISHED');
    assert.notEqual(first.retry_identity, second.retry_identity);
    assert.notEqual(first.branch, second.branch);
    assert.equal(remote.peekBranch(first.branch ?? ''), CREATED_SHA);
    assert.equal(remote.peekBranch(second.branch ?? ''), CREATED_SHA);
  });

  void it('fails closed without deleting or replacing a noncanonical identity branch', async () => {
    const request = publicationRequest();
    const remote = new FakePublicationRemote();
    remote.seedForeignPublicationBranch(request);
    remote.setBaseBlob(request.changedFile.gitBlobOid);
    const branch = automationPublicationBranch(request.policy, request.commandId);

    await assert.rejects(
      new AutomationPublisher(remote).publish(request),
      /commit provenance|stable publication|differs|noncanonical commit/i,
    );
    assert.equal(remote.peekBranch(branch), STALE_SHA);
  });

  void it('rejects a created PR whose actor is not the authenticated App', async () => {
    const remote = new FakePublicationRemote();
    remote.pullRequestAuthorLogin = 'human-reviewer';

    await assert.rejects(
      new AutomationPublisher(remote).publish(publicationRequest()),
      /pull request metadata differs/i,
    );
  });

  void it('rejects a draft PR during cross-attempt recovery', async () => {
    const remote = new FakePublicationRemote();
    const publisher = new AutomationPublisher(remote);
    const first = await publisher.publish(publicationRequest());
    assert.ok(first.pr_number);
    remote.mutatePullRequest(first.pr_number, { draft: true });

    await assert.rejects(
      publisher.publish(
        publicationRequest({
          workflowRunId: 9010,
          workflowRunAttempt: 2,
          evidence: {
            artifactId: 9010,
            artifactName: 'finding-registry-authority-input-9010-2',
            artifactSha256: 'd'.repeat(64),
          },
        }),
      ),
      /pull request metadata differs/i,
    );
  });

  void it('rejects a recovered PR whose stable body was edited', async () => {
    const remote = new FakePublicationRemote();
    const publisher = new AutomationPublisher(remote);
    const first = await publisher.publish(publicationRequest());
    assert.ok(first.pr_number);
    const original = await remote.getPullRequest(first.pr_number);
    remote.mutatePullRequest(first.pr_number, {
      body: `${original.body.trimEnd()}\nunauthorized edit\n`,
    });

    await assert.rejects(publisher.publish(publicationRequest()), /pull request metadata differs/i);
  });

  void it('fails closed when an exact-head PR has its retry marker removed', async () => {
    const remote = new FakePublicationRemote();
    const publisher = new AutomationPublisher(remote);
    const first = await publisher.publish(publicationRequest());
    assert.ok(first.pr_number);
    remote.mutatePullRequest(first.pr_number, {
      state: 'MERGED',
      merged: true,
      mergeCommitSha: MERGE_SHA,
      body: 'edited body without the stable retry marker',
    });
    assert.ok(first.branch);
    remote.simulateMergedBranchRemoval(first.branch);
    const mutationEventsBeforeRetry = remote.events.filter(
      (event) =>
        event.startsWith('create-branch:') ||
        event.startsWith('create-commit:') ||
        event.startsWith('create-pr:'),
    ).length;

    let failure: unknown;
    try {
      await publisher.publish(publicationRequest());
      assert.fail('Expected edited historical PR metadata to fail closed');
    } catch (error) {
      failure = error;
    }
    assert.match(
      failure instanceof Error ? failure.message : String(failure),
      /PR metadata was edited or is not canonical/i,
    );
    const failureResult = automationPublicationFailureResult(failure, {}, publicationRequest());
    assert.equal(failureResult.pr_number, first.pr_number);
    assert.equal(failureResult.pr_url, first.pr_url);
    assert.equal(
      remote.events.filter(
        (event) =>
          event.startsWith('create-branch:') ||
          event.startsWith('create-commit:') ||
          event.startsWith('create-pr:'),
      ).length,
      mutationEventsBeforeRetry,
    );
  });

  void it('rejects a merged stable-branch PR that is not reachable from current main', async () => {
    const remote = new FakePublicationRemote();
    const publisher = new AutomationPublisher(remote);
    const first = await publisher.publish(publicationRequest());
    assert.ok(first.pr_number);
    remote.mutatePullRequest(first.pr_number, {
      state: 'MERGED',
      merged: true,
      mergeCommitSha: '5'.repeat(40),
    });

    await assert.rejects(
      publisher.publish(publicationRequest()),
      /not reachable from the authenticated current main/i,
    );
  });

  void it('recovers a canonical merged publication after the live main base advances', async () => {
    const remote = new FakePublicationRemote();
    const publisher = new AutomationPublisher(remote);
    const first = await publisher.publish(publicationRequest());
    assert.ok(first.pr_number);
    remote.mutatePullRequest(first.pr_number, {
      state: 'MERGED',
      merged: true,
      mergeCommitSha: MERGE_SHA,
      baseSha: ADVANCED_MAIN_SHA,
    });
    remote.setMainSha(ADVANCED_MAIN_SHA);

    const recovered = await publisher.publish(publicationRequest());

    assert.equal(recovered.status, 'RECOVERED');
    assert.equal(recovered.pr_number, first.pr_number);
    assert.ok(remote.events.includes(`reachable:${MERGE_SHA}:${ADVANCED_MAIN_SHA}`));
  });

  void it('preserves commit and PR coordinates in one exclusive durable FAILED result', async () => {
    const request = publicationRequest();
    const remote = new FakePublicationRemote();
    remote.raceMode = 'pull-request-verification-failure';
    let failure: unknown;
    try {
      await new AutomationPublisher(remote).publish(request);
      assert.fail('Expected publication to fail after PR creation');
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof PublicationFailure);

    const result = automationPublicationFailureResult(failure, {}, request);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.commit_sha, CREATED_SHA);
    assert.equal(result.observed_branch_sha, CREATED_SHA);
    assert.equal(result.pr_number, 1);
    assert.equal(result.pr_url, 'https://github.com/Okan-wqm/aquaculture_platform/pull/1');
    assert.equal(result.retry_identity, automationPublicationRetryIdentity(request));
    assert.deepEqual(result.mutation_evidence, {
      artifact_id: request.evidence?.artifactId,
      artifact_name: request.evidence?.artifactName,
      artifact_sha256: request.evidence?.artifactSha256,
    });

    const runnerTemp = mkdtempSync(join(tmpdir(), 'automation-result-'));
    temporaryDirectories.push(runnerTemp);
    const resultPath = join(runnerTemp, 'finding-registry-publication.json');
    writeExclusiveDurableResult(
      resultPath,
      runnerTemp,
      result,
      'finding-registry-publication.json',
    );
    assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')) as unknown, result);
    assert.throws(
      () =>
        writeExclusiveDurableResult(
          resultPath,
          runnerTemp,
          result,
          'finding-registry-publication.json',
        ),
      /exist/i,
    );
  });

  void it('preserves the primary failure and every cleanup failure in deterministic order', () => {
    const primary = new Error('primary write failure');
    const closeFailure = new Error('descriptor cleanup failure');
    const unlinkFailure = new Error('staged-file cleanup failure');
    assert.throws(
      () => rethrowPublicationWriteErrors(primary, [closeFailure, null, unlinkFailure]),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [primary, closeFailure, unlinkFailure]);
        return true;
      },
    );
    assert.throws(() => rethrowPublicationWriteErrors(primary, []), primary);
    assert.throws(() => rethrowPublicationWriteErrors(null, [unlinkFailure]), unlinkFailure);
    assert.throws(
      () => rethrowPublicationWriteErrors('non-Error primary evidence', []),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { cause?: unknown }).cause, 'non-Error primary evidence');
        return true;
      },
    );
  });

  void it('records output-sink finalization failure as the one durable FAILED result', async () => {
    const request = publicationRequest();
    const published = await new AutomationPublisher(new FakePublicationRemote()).publish(request);
    const runnerTemp = mkdtempSync(join(tmpdir(), 'automation-finalization-'));
    temporaryDirectories.push(runnerTemp);
    const resultPath = join(runnerTemp, 'finding-registry-publication.json');

    const finalized = finalizeAutomationPublication(
      resultPath,
      runnerTemp,
      'finding-registry-publication.json',
      published,
      {},
      request,
      () => {
        throw new Error('simulated full GITHUB_OUTPUT filesystem');
      },
    );

    assert.equal(finalized.status, 'FAILED');
    assert.equal(finalized.commit_sha, published.commit_sha);
    assert.equal(finalized.pr_number, published.pr_number);
    assert.match(finalized.error ?? '', /GITHUB_OUTPUT finalization failed/);
    assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')) as unknown, finalized);
  });
});

class PaginatedPullRequestTransport implements GitHubAutomationPublicationTransport {
  public readonly requestedPages: number[] = [];

  public constructor(private readonly fillEveryPage = false) {}

  public get(path: string): Promise<unknown> {
    const page = Number(new URL(`https://api.github.test${path}`).searchParams.get('page'));
    this.requestedPages.push(page);
    const count = this.fillEveryPage ? 100 : page === 1 ? 100 : page === 2 ? 1 : 0;
    return Promise.resolve(
      Array.from({ length: count }, (_, index) => ({
        number: (page - 1) * 100 + index + 1,
        head: { sha: String(page).repeat(40) },
        title: page === 2 ? 'old stable retry' : 'other publication',
        body: page === 2 ? '<!-- aqua-automation-retry-identity:old -->' : 'other',
      })),
    );
  }

  public post(): Promise<never> {
    throw new Error('Unexpected POST in pagination test');
  }

  public graphql(): Promise<never> {
    throw new Error('Unexpected GraphQL call in pagination test');
  }
}

void describe('bounded pull request history enumeration', () => {
  void it('bounds the worst sequential network wait below the workflow kill window', () => {
    assert.equal(
      AUTOMATION_PUBLICATION_NETWORK_BUDGET.maximumSequentialWaitMs,
      AUTOMATION_PUBLICATION_NETWORK_BUDGET.perCallTimeoutMs *
        AUTOMATION_PUBLICATION_NETWORK_BUDGET.maxApiCalls,
    );
    assert.ok(AUTOMATION_PUBLICATION_NETWORK_BUDGET.maximumSequentialWaitMs <= 240_000);
  });

  void it('enumerates a stable retry beyond the first full page', async () => {
    const transport = new PaginatedPullRequestTransport();
    const remote = new GitHubAutomationPublicationRemote(transport);

    const summaries = await remote.listPullRequests('automation/finding-registry-active');

    assert.equal(summaries.length, 101);
    assert.equal(summaries[100]?.title, 'old stable retry');
    assert.deepEqual(transport.requestedPages, [1, 2]);
  });

  void it('fails closed instead of truncating history at the explicit page bound', async () => {
    const transport = new PaginatedPullRequestTransport(true);
    const remote = new GitHubAutomationPublicationRemote(transport);

    await assert.rejects(
      remote.listPullRequests('automation/finding-registry-active'),
      /history exceeds the fail-closed pagination bound/,
    );
    assert.deepEqual(transport.requestedPages, [1, 2, 3, 4]);
  });
});

class InstallationIdentityTransport implements GitHubAutomationPublicationTransport {
  public get(path: string): Promise<unknown> {
    if (path === '/installation/repositories?per_page=2') {
      return Promise.resolve({
        total_count: 1,
        repositories: [
          {
            id: 1132698735,
            name: 'aquaculture_platform',
            full_name: 'Okan-wqm/aquaculture_platform',
            owner: { login: 'Okan-wqm', id: 77401788 },
          },
        ],
      });
    }
    throw new Error(`Unexpected GET: ${path}`);
  }

  public post(): Promise<never> {
    throw new Error('Unexpected POST in identity test');
  }

  public graphql(): Promise<unknown> {
    return Promise.resolve({ data: { viewer: { login: 'aqua-automation[bot]' } } });
  }
}

void describe('GitHub App installation identity', () => {
  void it('binds the trusted installation output to the App principal and one repository', async () => {
    const remote = new GitHubAutomationPublicationRemote(new InstallationIdentityTransport());

    await remote.assertInstallationIdentity('aqua-automation', 1234);
    await assert.rejects(
      remote.assertInstallationIdentity('aqua-automation', 0),
      /installation output is invalid/,
    );
  });
});

class CommitIdentityTransport implements GitHubAutomationPublicationTransport {
  public constructor(
    private readonly requestedSha: string,
    private readonly gitCommitSha = requestedSha,
    private readonly commitViewSha = requestedSha,
    private readonly graphqlCommitSha = requestedSha,
  ) {}

  public get(path: string): Promise<unknown> {
    if (path.includes('/git/commits/')) {
      return Promise.resolve({
        sha: this.gitCommitSha,
        message: 'canonical commit message',
        verification: { verified: true, reason: 'valid' },
        parents: [{ sha: BASE_SHA }],
      });
    }
    if (path.includes('/commits/')) {
      return Promise.resolve({
        sha: this.commitViewSha,
        author: { login: 'aqua-automation[bot]' },
        files: [{ filename: REGISTRY_PATH }],
      });
    }
    if (path.includes('/contents/')) {
      return Promise.resolve({ sha: '8'.repeat(40) });
    }
    throw new Error(`Unexpected GET: ${path}`);
  }

  public post(): Promise<never> {
    throw new Error('Unexpected POST in commit identity test');
  }

  public graphql(_query: string, variables: JsonRecord): Promise<unknown> {
    assert.equal(variables.name, 'aquaculture_platform');
    assert.equal(variables.oid, this.requestedSha);
    return Promise.resolve({
      data: {
        repository: {
          object: {
            oid: this.graphqlCommitSha,
            signature: {
              isValid: true,
              state: 'VALID',
              wasSignedByGitHub: true,
            },
          },
        },
      },
    });
  }
}

void describe('cross-source commit identity', () => {
  void it('requires the requested SHA from both REST views and GraphQL', async () => {
    const requestedSha = '6'.repeat(40);
    const remote = new GitHubAutomationPublicationRemote(new CommitIdentityTransport(requestedSha));
    assert.equal((await remote.getCommit(requestedSha, REGISTRY_PATH)).sha, requestedSha);

    await assert.rejects(
      new GitHubAutomationPublicationRemote(
        new CommitIdentityTransport(requestedSha, '7'.repeat(40), requestedSha, requestedSha),
      ).getCommit(requestedSha, REGISTRY_PATH),
      /REST and GraphQL commit identities disagree/,
    );
  });
});

class WrongPullRequestIdentityTransport implements GitHubAutomationPublicationTransport {
  public get(path: string): Promise<unknown> {
    assert.match(path, /\/pulls\/42$/);
    return Promise.resolve({
      number: 41,
      html_url: 'https://github.com/Okan-wqm/aquaculture_platform/pull/41',
      state: 'open',
      merged: false,
      merge_commit_sha: null,
      base: { ref: 'main', sha: BASE_SHA },
      head: {
        ref: 'automation/finding-registry-active',
        sha: CREATED_SHA,
        repo: { full_name: 'Okan-wqm/aquaculture_platform' },
      },
      user: { login: 'aqua-automation[bot]' },
      draft: false,
      title: 'canonical title',
      body: 'canonical body',
    });
  }

  public post(): Promise<never> {
    throw new Error('Unexpected POST in pull request identity test');
  }

  public graphql(_query: string, variables: JsonRecord): Promise<unknown> {
    assert.equal(variables.name, 'aquaculture_platform');
    assert.equal(variables.number, 42);
    return Promise.resolve({
      data: {
        repository: {
          pullRequest: {
            number: 41,
            url: 'https://github.com/Okan-wqm/aquaculture_platform/pull/41',
            state: 'OPEN',
            merged: false,
            mergeCommit: null,
            baseRefName: 'main',
            baseRefOid: BASE_SHA,
            headRefName: 'automation/finding-registry-active',
            headRefOid: CREATED_SHA,
            headRepository: {
              nameWithOwner: 'Okan-wqm/aquaculture_platform',
            },
            author: { login: 'aqua-automation[bot]' },
            isDraft: false,
            title: 'canonical title',
            body: 'canonical body',
          },
        },
      },
    });
  }
}

void describe('cross-source pull request identity', () => {
  void it('rejects mutually agreeing REST/GraphQL data for the wrong requested number', async () => {
    const remote = new GitHubAutomationPublicationRemote(new WrongPullRequestIdentityTransport());

    await assert.rejects(
      remote.getPullRequest(42),
      /REST and GraphQL pull request metadata disagree/,
    );
  });
});

void describe('GitHub output boundary', () => {
  void it('writes only canonical single-line values and rejects symlink/injection targets', () => {
    const request = publicationRequest();
    const result = automationPublicationFailureResult(
      new Error('publication\0failed\nwith\u007fcontrols\u0085'),
      {},
      request,
    );
    assert.equal(result.error, 'publication failed with controls ');
    const runnerTemp = mkdtempSync(join(tmpdir(), 'automation-output-'));
    temporaryDirectories.push(runnerTemp);
    const outputPath = join(runnerTemp, 'github-output');
    const symlinkPath = join(runnerTemp, 'github-output-link');
    writeFileSync(outputPath, '');
    symlinkSync(outputPath, symlinkPath);

    writeGitHubOutputs(outputPath, result);
    assert.equal(readFileSync(outputPath, 'utf8'), 'status=FAILED\ncommit=\npr=\n');
    assert.throws(() => writeGitHubOutputs(symlinkPath, result), /symbolic link|ELOOP/i);
    assert.throws(
      () =>
        writeGitHubOutputs(outputPath, {
          ...result,
          pr_number: 1,
          pr_url: 'https://github.com/Okan-wqm/aquaculture_platform/pull/1\nstatus=PUBLISHED',
        }),
      /unsafe for GITHUB_OUTPUT/,
    );
  });
});

void describe('report content-digest authority', () => {
  void it('requires the report request digest to equal the immutable content digest', () => {
    const bytes = Buffer.from('daily report\n', 'utf8');
    const policy = resolveAutomationPublicationPolicy({
      operation: 'report',
      commandId: 'aria-daily-report:2026-07-30',
      baseSha: BASE_SHA,
      workflowRef:
        'Okan-wqm/aquaculture_platform/.github/workflows/aria-daily-report.yml@refs/heads/main',
      branch: 'automation/aria-daily-report-2026-07-30',
      changedPath: 'aria-tools/reports/daily/2026-07-30.md',
      commitHeadline: 'chore(aria-reports): daily 2026-07-30',
      pullRequestTitle: 'chore(aria-reports): daily 2026-07-30',
    });
    const snapshot = {
      path: policy.changedPath,
      bytes,
      sha256: sha256(bytes),
      gitBlobOid: gitBlobOid(bytes),
    };

    assert.doesNotThrow(() =>
      assertAutomationPublicationInputDigest(policy, snapshot, snapshot.sha256),
    );
    assert.throws(
      () => assertAutomationPublicationInputDigest(policy, snapshot, '0'.repeat(64)),
      /must equal the immutable report content digest/,
    );
  });
});

function canonicalEnvironmentFixture(): {
  readonly repositoryRoot: string;
  readonly env: NodeJS.ProcessEnv;
} {
  const parent = mkdtempSync(join(tmpdir(), 'automation-env-contract-'));
  temporaryDirectories.push(parent);
  const repositoryRoot = join(parent, 'repository');
  const runnerTemp = join(parent, 'runner-temp');
  mkdirSync(repositoryRoot);
  mkdirSync(runnerTemp);
  mkdirSync(join(repositoryRoot, 'docs', 'reviews', '_registry'), {
    recursive: true,
  });
  const changedBytes = Buffer.from('{"finding_id":"TEST-HIGH-001"}\n', 'utf8');
  writeFileSync(join(repositoryRoot, REGISTRY_PATH), changedBytes);
  execFileSync('git', ['init', '--quiet', repositoryRoot]);
  execFileSync('git', ['-C', repositoryRoot, 'add', REGISTRY_PATH]);
  execFileSync('git', [
    '-C',
    repositoryRoot,
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Automation Contract',
    '-c',
    'user.email=automation@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const head = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const bodyPath = join(runnerTemp, 'pull-request-body.md');
  writeFileSync(bodyPath, 'Canonical finding registry mutation.\n');
  return {
    repositoryRoot,
    env: {
      GITHUB_REPOSITORY: 'Okan-wqm/aquaculture_platform',
      GITHUB_REPOSITORY_ID: '1132698735',
      GITHUB_REPOSITORY_OWNER: 'Okan-wqm',
      GITHUB_REPOSITORY_OWNER_ID: '77401788',
      BASE_BRANCH: 'main',
      GITHUB_ACTIONS: 'true',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_PROTECTED: 'true',
      EXPECTED_BASE_SHA: head,
      GITHUB_WORKFLOW_SHA: head,
      GITHUB_SHA: head,
      AUTOMATION_COMMAND_ID: 'finding-request:TEST-HIGH-001',
      AUTOMATION_OPERATION: 'add',
      CHANGED_PATHS: REGISTRY_PATH,
      PR_BRANCH: 'automation/finding-registry-active',
      PR_TITLE: 'chore(findings): canonical add mutation',
      COMMIT_MESSAGE: 'chore(findings): canonical add mutation',
      GITHUB_WORKFLOW_REF: REGISTRY_WORKFLOW_REF,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      AUTOMATION_INPUT_SHA256: INPUT_SHA256,
      PR_BODY_FILE: bodyPath,
      RUNNER_TEMP: runnerTemp,
      GITHUB_RUN_ID: '9001',
      GITHUB_RUN_ATTEMPT: '1',
      GH_APP_SLUG: 'aqua-automation',
      GH_APP_INSTALLATION_ID: '1234',
      AUTOMATION_EVIDENCE_ARTIFACT_ID: '9001',
      AUTOMATION_EVIDENCE_ARTIFACT: 'finding-registry-authority-input-9001-1',
      AUTOMATION_EVIDENCE_SHA256: EVIDENCE_SHA256,
    },
  };
}

void describe('workflow environment trust boundary', () => {
  void it('accepts only the exact repository, protected-main, workflow, event, and local HEAD', () => {
    const fixture = canonicalEnvironmentFixture();
    const request = publicationRequestFromEnvironment(fixture.env, fixture.repositoryRoot);
    assert.equal(request.baseSha, fixture.env.EXPECTED_BASE_SHA);
    assert.equal(request.policy.key, 'registry-add');

    const otherSha = '9'.repeat(40);
    for (const [label, overrides] of [
      ['repository ID', { GITHUB_REPOSITORY_ID: '1' }],
      ['owner ID', { GITHUB_REPOSITORY_OWNER_ID: '1' }],
      ['protected ref', { GITHUB_REF_PROTECTED: 'false' }],
      ['workflow SHA', { GITHUB_WORKFLOW_SHA: otherSha }],
      [
        'workflow ref',
        {
          GITHUB_WORKFLOW_REF:
            'Okan-wqm/aquaculture_platform/.github/workflows/other.yml@refs/heads/main',
        },
      ],
      ['workflow event', { GITHUB_EVENT_NAME: 'push' }],
      [
        'local HEAD',
        {
          EXPECTED_BASE_SHA: otherSha,
          GITHUB_WORKFLOW_SHA: otherSha,
          GITHUB_SHA: otherSha,
        },
      ],
    ] as const) {
      assert.throws(
        () =>
          publicationRequestFromEnvironment(
            { ...fixture.env, ...overrides },
            fixture.repositoryRoot,
          ),
        /./,
        label,
      );
    }
  });
});

void describe('immutable publication input snapshot', () => {
  void it('returns content-bound hashes for a regular file and rejects a symlink target', () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'automation-publication-'));
    temporaryDirectories.push(repositoryRoot);
    mkdirSync(join(repositoryRoot, 'inputs'));
    const contents = Buffer.from('canonical report\n', 'utf8');
    writeFileSync(join(repositoryRoot, 'inputs', 'report.md'), contents);
    symlinkSync('report.md', join(repositoryRoot, 'inputs', 'report-link.md'));

    const snapshot = readImmutableFileSnapshot(repositoryRoot, 'inputs/report.md');
    assert.equal(snapshot.path, 'inputs/report.md');
    assert.deepEqual(snapshot.bytes, contents);
    assert.equal(snapshot.sha256, sha256(contents));
    assert.equal(snapshot.gitBlobOid, gitBlobOid(contents));
    assert.throws(
      () => readImmutableFileSnapshot(repositoryRoot, 'inputs/report-link.md'),
      /canonical repository root|symbolic link|non-symlink regular file/i,
    );
  });

  void it('rejects a regular-file replacement between path stat and descriptor open', (context) => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'automation-publication-race-'));
    temporaryDirectories.push(repositoryRoot);
    const governedPath = join(repositoryRoot, 'report.md');
    const replacementPath = join(repositoryRoot, 'replacement.md');
    const displacedPath = join(repositoryRoot, 'report.displaced.md');
    writeFileSync(governedPath, 'governed bytes\n');
    writeFileSync(replacementPath, 'replacement bytes\n');

    const originalOpenSync = fs.openSync;
    let replaced = false;
    context.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>): number => {
      if (!replaced && String(args[0]).endsWith('/report.md')) {
        replaced = true;
        renameSync(governedPath, displacedPath);
        renameSync(replacementPath, governedPath);
      }
      return originalOpenSync(...args);
    });
    assert.throws(
      () => readImmutableFileSnapshot(repositoryRoot, 'report.md'),
      /path identity changed/,
    );
    assert.equal(replaced, true);
  });

  void it('keeps traversal anchored when an intermediate directory path is replaced', (context) => {
    const parent = mkdtempSync(join(tmpdir(), 'automation-ancestor-race-'));
    temporaryDirectories.push(parent);
    const repositoryRoot = join(parent, 'repository');
    const outsideRoot = join(parent, 'outside');
    mkdirSync(repositoryRoot);
    mkdirSync(outsideRoot);
    mkdirSync(join(repositoryRoot, 'inputs'));
    writeFileSync(join(repositoryRoot, 'inputs', 'report.md'), 'governed bytes\n');
    writeFileSync(join(outsideRoot, 'report.md'), 'outside bytes\n');

    const originalOpenSync = fs.openSync;
    let replaced = false;
    context.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>): number => {
      if (!replaced && /^\/proc\/self\/fd\/[0-9]+\/report\.md$/.test(String(args[0]))) {
        replaced = true;
        renameSync(join(repositoryRoot, 'inputs'), join(repositoryRoot, 'inputs.displaced'));
        symlinkSync(outsideRoot, join(repositoryRoot, 'inputs'), 'dir');
      }
      return originalOpenSync(...args);
    });
    const snapshot = readImmutableFileSnapshot(repositoryRoot, 'inputs/report.md');
    assert.equal(snapshot.bytes.toString('utf8'), 'governed bytes\n');
    assert.equal(replaced, true);
  });

  void it('rejects replacement of the canonical repository root before fd anchoring', (context) => {
    const parent = mkdtempSync(join(tmpdir(), 'automation-root-race-'));
    temporaryDirectories.push(parent);
    const repositoryRoot = join(parent, 'repository');
    const replacementRoot = join(parent, 'replacement');
    mkdirSync(repositoryRoot);
    mkdirSync(replacementRoot);
    writeFileSync(join(repositoryRoot, 'report.md'), 'governed bytes\n');
    writeFileSync(join(replacementRoot, 'report.md'), 'replacement bytes\n');

    const originalOpenSync = fs.openSync;
    let replaced = false;
    context.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>): number => {
      if (!replaced && args[0] === repositoryRoot) {
        replaced = true;
        renameSync(repositoryRoot, join(parent, 'repository.displaced'));
        renameSync(replacementRoot, repositoryRoot);
      }
      return originalOpenSync(...args);
    });
    assert.throws(
      () => readImmutableFileSnapshot(repositoryRoot, 'report.md'),
      /root identity changed/,
    );
    assert.equal(replaced, true);
  });
});
