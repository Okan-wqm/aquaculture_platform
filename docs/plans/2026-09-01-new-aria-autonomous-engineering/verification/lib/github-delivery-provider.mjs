import { canonicalJson, sha256 } from './canonical.mjs';
import * as rulesetPolicy from './github-ruleset-policy.mjs';
const exactSha = /^[a-f0-9]{40}$/u;
const exactUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const slugPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const requiredCheckRoster = [
  { context: 'aria-merge-authority', app_id: 15368 },
  { context: 'build-status', app_id: 15368 },
  { context: 'merge-gate', app_id: 15368 },
  { context: 'sens-enterprise-summary', app_id: 15368 },
];
function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  return value;
}
function validSha(value, label) {
  if (typeof value !== 'string' || !exactSha.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function validTimestamp(value, label) {
  const milliseconds = typeof value === 'string' && exactUtc.test(value) ? Date.parse(value) : NaN;
  const canonical =
    typeof value === 'string' && value.length === 20 ? value.replace('Z', '.000Z') : value;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== canonical) {
    throw new Error(`${label} is invalid`);
  }
  return milliseconds;
}
function headers(token) {
  const value = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2026-03-10',
    'user-agent': 'new-aria-delivery-readback',
  };
  if (typeof token === 'string' && token.length > 0) value.authorization = `Bearer ${token}`;
  return value;
}
function rejectPagination(response, label) {
  if (!response.headers || typeof response.headers.get !== 'function') {
    throw new Error(`GitHub ${label} pagination metadata is unavailable`);
  }
  const link = response.headers.get('link');
  if (
    link &&
    /(?:^|[;,])\s*rel\s*=\s*(?:"[^"]*\bnext\b[^"]*"|next)(?=\s*(?:[;,]|$))/iu.test(link)
  ) {
    throw new Error(`GitHub ${label} pagination is incomplete`);
  }
}

async function githubJson(url, token, completePageLabel) {
  const response = await globalThis.fetch(url, { method: 'GET', headers: headers(token) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  if (completePageLabel) rejectPagination(response, completePageLabel);
  return response.json();
}

function protectionChecks(protection) {
  const statusChecks = protection?.required_status_checks;
  if (statusChecks?.strict !== true) throw new Error('GitHub required checks must be strict');
  if (protection?.enforce_admins?.enabled !== true) {
    throw new Error('GitHub branch protection must enforce admins');
  }
  if (
    Object.hasOwn(protection ?? {}, 'required_pull_request_reviews') &&
    protection.required_pull_request_reviews !== null
  ) {
    throw new Error('GitHub classic pull-request review protection is unsupported or drifted');
  }
  if (!Array.isArray(statusChecks.checks) || statusChecks.checks.length === 0) {
    throw new Error('GitHub branch protection must expose exact required checks');
  }
  const checks = statusChecks.checks.map((check) => {
    if (
      typeof check?.context !== 'string' ||
      check.context.length === 0 ||
      !(check.app_id === null || Number.isSafeInteger(check.app_id))
    ) {
      throw new Error('GitHub required check identity is invalid');
    }
    return { context: check.context, app_id: check.app_id };
  });
  checks.sort((left, right) => left.context.localeCompare(right.context));
  if (new Set(checks.map(({ context }) => context)).size !== checks.length) {
    throw new Error('GitHub required check contexts are ambiguous');
  }
  if (JSON.stringify(checks) !== JSON.stringify(requiredCheckRoster)) {
    throw new Error('GitHub required check roster is weakened or drifted');
  }
  return checks;
}

function successfulChecks(requiredChecks, response, headSha, mergedAt) {
  if (
    !Number.isSafeInteger(response?.total_count) ||
    !Array.isArray(response.check_runs) ||
    response.total_count !== response.check_runs.length
  ) {
    throw new Error('GitHub check-run result is incomplete');
  }
  return requiredChecks.map((expected) => {
    const candidates = response.check_runs.filter((run) => run?.name === expected.context);
    if (candidates.length !== 1) {
      throw new Error(`GitHub required check ${expected.context} is missing or ambiguous`);
    }
    const run = candidates[0];
    if (run?.app?.id !== expected.app_id) {
      throw new Error(`GitHub required check ${expected.context} has the wrong App identity`);
    }
    if (run.head_sha !== headSha)
      throw new Error(`GitHub required check ${expected.context} head mismatch`);
    if (run.status !== 'completed' || run.conclusion !== 'success') {
      throw new Error(`GitHub required check ${expected.context} is not SUCCESS`);
    }
    const completedAt = validTimestamp(run.completed_at, 'GitHub check completed_at');
    if (completedAt >= mergedAt)
      throw new Error('GitHub check completed_at is not before pull merged_at');
    if (!Number.isSafeInteger(run.id)) throw new Error('GitHub check-run identity is invalid');
    return {
      context: expected.context,
      app_id: expected.app_id,
      check_run_id: run.id,
      head_sha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      completed_at: run.completed_at,
    };
  });
}

function validateRepository(repository, slug, baseRef) {
  if (
    repository?.full_name !== slug ||
    repository?.private !== false ||
    repository?.default_branch !== baseRef ||
    !Number.isSafeInteger(repository?.id) ||
    typeof repository?.node_id !== 'string'
  ) {
    throw new Error('GitHub repository identity must be the expected public repository');
  }
}

function validatePullRequest(pull, pullRequestNumber, baseRef) {
  if (
    pull?.number !== pullRequestNumber ||
    pull?.state !== 'closed' ||
    pull?.merged !== true ||
    pull?.base?.ref !== baseRef
  ) {
    throw new Error('GitHub pull request is not merged into the expected base');
  }
  for (const [value, label] of [
    [pull?.base?.sha, 'pull request base SHA'],
    [pull?.head?.sha, 'pull request head SHA'],
    [pull?.merge_commit_sha, 'pull request merge SHA'],
  ]) {
    validSha(value, label);
  }
  required(pull?.html_url, 'pull request URL');
  return validTimestamp(pull.merged_at, 'pull merged_at');
}

async function resolvedRulesets(apiRoot, token, baseRef, repositorySlug) {
  const listed = await githubJson(
    `${apiRoot}/rules/branches/${encodeURIComponent(baseRef)}?per_page=100`,
    token,
    'ruleset-list',
  );
  const identifiers = rulesetPolicy.effectiveRulesetIds(listed, repositorySlug);
  const details = await Promise.all(
    identifiers.map((id) => githubJson(`${apiRoot}/rulesets/${id}`, token)),
  );
  return rulesetPolicy.validatedRulesets(details, identifiers, repositorySlug, baseRef);
}

function validateRequest(repositorySlug, pullRequestNumber, baseRef) {
  if (!slugPattern.test(repositorySlug ?? '')) throw new Error('GitHub repository slug is invalid');
  if (baseRef !== 'main') throw new Error('GitHub delivery base must be exact main');
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error('GitHub pull request number is invalid');
  }
  required(baseRef, 'GitHub base ref');
}

function validateMain(mainRef, baseRef) {
  const mainSha = validSha(mainRef?.object?.sha, 'GitHub main SHA');
  if (mainRef?.ref !== `refs/heads/${baseRef}` || mainRef?.object?.type !== 'commit') {
    throw new Error('GitHub main ref identity mismatch');
  }
  return mainSha;
}

function mergeParents(mergeCommit, expectedSha) {
  const parents = mergeCommit?.parents;
  if (mergeCommit?.sha !== expectedSha || !Array.isArray(parents) || parents.length !== 2) {
    throw new Error('GitHub merge commit must have exactly two valid parents');
  }
  const shas = parents.map(({ sha }) => sha);
  if (shas.some((sha) => !exactSha.test(sha ?? ''))) {
    throw new Error('GitHub merge commit must have exactly two valid parents');
  }
  return shas;
}

export async function resolveGitHubDeliveryFacts({
  repositorySlug,
  pullRequestNumber,
  baseRef,
  githubToken,
}) {
  validateRequest(repositorySlug, pullRequestNumber, baseRef);
  const apiRoot = `https://api.github.com/repos/${repositorySlug}`;
  const repository = await githubJson(apiRoot, githubToken);
  const pull = await githubJson(`${apiRoot}/pulls/${pullRequestNumber}`, githubToken);
  validateRepository(repository, repositorySlug, baseRef);
  const mergedAt = validatePullRequest(pull, pullRequestNumber, baseRef);
  const [mainRef, mergeCommit, protection, checkRuns, rulesets] = await Promise.all([
    githubJson(`${apiRoot}/git/ref/heads/${encodeURIComponent(baseRef)}`, githubToken),
    githubJson(`${apiRoot}/commits/${pull.merge_commit_sha}`, githubToken),
    githubJson(`${apiRoot}/branches/${encodeURIComponent(baseRef)}/protection`, githubToken),
    githubJson(
      `${apiRoot}/commits/${pull.head.sha}/check-runs?filter=latest&per_page=100`,
      githubToken,
      'check-runs',
    ),
    resolvedRulesets(apiRoot, githubToken, baseRef, repositorySlug),
  ]);
  const mainSha = validateMain(mainRef, baseRef);
  const parentShas = mergeParents(mergeCommit, pull.merge_commit_sha);
  const configuredChecks = protectionChecks(protection);
  const requiredChecks = successfulChecks(configuredChecks, checkRuns, pull.head.sha, mergedAt);
  return {
    repository_id: repository.id,
    repository_node_id: repository.node_id,
    pull_request_url: pull.html_url,
    pull_merged_at: pull.merged_at,
    base_ref: pull.base.ref,
    base_sha: pull.base.sha,
    head_sha: pull.head.sha,
    merge_commit_sha: pull.merge_commit_sha,
    merge_parent_shas: parentShas,
    main_sha: mainSha,
    enforce_admins: true,
    strict_required_checks: true,
    required_checks: requiredChecks,
    required_checks_sha256: sha256(Buffer.from(canonicalJson(requiredChecks), 'utf8')),
    ruleset_sha256: sha256(Buffer.from(canonicalJson(rulesets), 'utf8')),
  };
}
