import { canonicalJson, sha256 } from './lib/canonical.mjs';
import { D0_DELIVERY_CONTEXT, d0ReadbackId } from './lib/delivery-readback-contract.mjs';

export const mergeSha = '3'.repeat(40);
export const contexts = [
  'aria-merge-authority',
  'build-status',
  'merge-gate',
  'sens-enterprise-summary',
];
const ruleset = {
  id: 91,
  name: 'main protection',
  target: 'branch',
  source_type: 'Repository',
  source: D0_DELIVERY_CONTEXT.repository_slug,
  enforcement: 'active',
  bypass_actors: [],
  current_user_can_bypass: 'never',
  conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
  rules: [{ type: 'non_fast_forward' }],
};
const rulesetSha = sha256(Buffer.from(canonicalJson([ruleset]), 'utf8'));

function requiredChecks(headSha, completedAt) {
  return contexts.map((context, index) => ({
    context,
    app_id: 15368,
    check_run_id: 100 + index,
    head_sha: headSha,
    status: 'completed',
    conclusion: 'success',
    completed_at: completedAt,
  }));
}

function finalNoteBody(expected) {
  const note = {
    schema_version: '1.0.0',
    contract_id: 'new-aria-d0-final-note-v1',
    program_id: D0_DELIVERY_CONTEXT.program_id,
    work_unit_id: D0_DELIVERY_CONTEXT.work_unit_id,
    successor_work_unit_id: D0_DELIVERY_CONTEXT.successor_work_unit_id,
    pull_request_number: D0_DELIVERY_CONTEXT.pull_request_number,
    readback_id: expected.readbackId,
    reviewed_head_sha: expected.reviewedHeadSha,
    review_dossier_sha256: expected.reviewDossierSha256,
    review_admission_sha256: expected.reviewAdmissionSha256,
    unresolved_load_bearing_findings: [],
    status: 'ACCEPTED',
  };
  return `<!-- new-aria-d0-final-note-v1 -->\n${canonicalJson(note)}\n`;
}

function finalNote(expected, createdAt) {
  const body = finalNoteBody(expected);
  const identity = {
    id: 9001,
    node_id: 'IC_kwDOQ4Ocb86gZGVhZA',
    html_url: 'https://github.com/Okan-wqm/aquaculture_platform/pull/1393#issuecomment-9001',
    created_at: createdAt,
    author_id: 77401788,
    author_node_id: 'MDQ6VXNlcjc3NDAxNzg4',
  };
  return {
    comment: {
      id: identity.id,
      node_id: identity.node_id,
      html_url: identity.html_url,
      body,
      created_at: createdAt,
      updated_at: createdAt,
      author_association: 'OWNER',
      user: {
        login: 'Okan-wqm',
        id: identity.author_id,
        node_id: identity.author_node_id,
        type: 'User',
      },
    },
    finalNoteSha256: sha256(Buffer.from(body, 'utf8')),
    finalNoteIdentitySha256: sha256(Buffer.from(canonicalJson(identity), 'utf8')),
  };
}

function providerBodies(baseSha, headSha, checks, mergedAt, comments) {
  return {
    repository: {
      id: 1132698735,
      node_id: 'R_kgDOQ4Ocbw',
      full_name: D0_DELIVERY_CONTEXT.repository_slug,
      private: false,
      default_branch: D0_DELIVERY_CONTEXT.base_ref,
    },
    pull: {
      number: 1393,
      html_url: 'https://github.com/Okan-wqm/aquaculture_platform/pull/1393',
      state: 'closed',
      merged: true,
      merged_at: mergedAt,
      base: { ref: 'main', sha: baseSha },
      head: { sha: headSha },
      merge_commit_sha: mergeSha,
    },
    ref: { ref: 'refs/heads/main', object: { type: 'commit', sha: mergeSha } },
    commit: { sha: mergeSha, parents: [{ sha: baseSha }, { sha: headSha }] },
    protection: {
      required_status_checks: {
        strict: true,
        contexts,
        checks: contexts.map((context) => ({ context, app_id: 15368 })),
      },
      enforce_admins: { enabled: true },
    },
    checks: {
      total_count: contexts.length,
      check_runs: checks.map((check) => ({
        id: check.check_run_id,
        name: check.context,
        head_sha: check.head_sha,
        status: check.status,
        conclusion: check.conclusion,
        completed_at: check.completed_at,
        app: { id: check.app_id },
      })),
    },
    effectiveRules: [
      {
        type: 'non_fast_forward',
        ruleset_source_type: 'Repository',
        ruleset_source: D0_DELIVERY_CONTEXT.repository_slug,
        ruleset_id: 91,
      },
    ],
    ruleset,
    comments,
  };
}

export function githubDeliveryFixture(admission, now = Date.now()) {
  const headSha = admission.reviewed_head_sha;
  const mergedAt = new Date(now - 10_000).toISOString();
  const completedAt = new Date(now - 20_000).toISOString();
  const expected = {
    readbackId: d0ReadbackId(headSha),
    reviewedBaseSha: admission.reviewed_base_sha,
    reviewedHeadSha: headSha,
    reviewDossierSha256: admission.dossier_sha256,
    reviewAdmissionSha256: admission.review_admission_sha256,
  };
  const note = finalNote(expected, new Date(now - 15_000).toISOString());
  const checks = requiredChecks(headSha, completedAt);
  return {
    expected: { ...expected, ...note },
    mergedAt,
    checksSha: sha256(Buffer.from(canonicalJson(checks), 'utf8')),
    rulesetSha,
    bodies: providerBodies(expected.reviewedBaseSha, headSha, checks, mergedAt, [note.comment]),
  };
}

function response(body) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body };
}

export function installGitHubFetch(fixture) {
  const previous = globalThis.fetch;
  const calls = [];
  const { bodies } = fixture;
  globalThis.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith('/pulls/1393')) return response(bodies.pull);
    if (value.endsWith('/git/ref/heads/main')) return response(bodies.ref);
    if (value.endsWith(`/commits/${mergeSha}`)) return response(bodies.commit);
    if (value.endsWith('/branches/main/protection')) return response(bodies.protection);
    if (value.includes('/check-runs?')) return response(bodies.checks);
    if (value.endsWith('/rulesets/91')) return response(bodies.ruleset);
    if (value.includes('/rules/branches/')) return response(bodies.effectiveRules);
    if (value.includes('/issues/1393/comments?')) return response(bodies.comments);
    if (value.endsWith('/aquaculture_platform')) return response(bodies.repository);
    throw new Error(`unexpected URL ${url}`);
  };
  return { calls, restore: () => (globalThis.fetch = previous) };
}
