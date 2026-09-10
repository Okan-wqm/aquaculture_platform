#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStrictJson } from './lib/canonical.mjs';
import { verifyAuthorityContracts } from './lib/verify-authority.mjs';
import { mutateJson, planRoot, replace, withPlanCopy } from './test-support.mjs';
const policy = parseStrictJson(
  readFileSync(join(planRoot, 'verification/delivery-policy.json'), 'utf8'),
);
const expectedReadback = {
  repository_prs_per_work_unit: 1,
  final_note_location: 'reviewed work-unit PR',
  post_review_reviewed_head_mutation: 'FORBIDDEN',
  post_review_allowed_repository_effect: 'PROTECTED_MERGE_COMMIT_TO_TARGET_BASE_ONLY',
  post_merge_readback: 'EXTERNAL_SIGNED_OPERATOR_RECORD',
  readback_repository_commit: 'FORBIDDEN',
  successor_gate: 'admitted readback from then-current exact main SHA',
  post_readback_executor_cycle_ordering: 'NOT_AUTHORIZED',
  readback_contract: {
    contract_id: 'new-aria-delivery-readback-v1',
    envelope_kind: 'new-aria-delivery-readback',
    provider: 'GITHUB_API',
    target_ref: 'refs/heads/main',
    max_freshness_seconds: 300,
    canonical_utc: 'YYYY-MM-DDTHH:mm:ss.sssZ',
    observation_sequence_min: 1,
    bypass_attestation: {
      field: 'bypass_used',
      required_value: false,
      evidence_class: 'operator_attested',
      github_live_history: 'NOT_CLAIMED',
      merge_command: 'gh pr merge --merge --match-head-commit',
      admin_flag: 'FORBIDDEN',
    },
    bootstrap_identity: {
      program_id: 'new-aria-autonomous-engineering',
      work_unit_id: 'D0',
      successor_work_unit_id: 'S01',
      repository_slug: 'Okan-wqm/aquaculture_platform',
      pull_request_number: 1393,
      readback_id_derivation: 'd0-readback-${reviewed_head_sha[0:16]}',
      caller_expected_values: 'FORBIDDEN',
    },
    post_merge_observation: 'observed_at >= pull.merged_at + 1000ms',
    final_note_contract: {
      location: 'EXACT_UNIQUE_GITHUB_PR_COMMENT',
      raw_body_sha256: 'REQUIRED',
      natural_identity_sha256: 'REQUIRED',
      review_admission_sha256: 'REQUIRED',
    },
    required_check_roster: [
      { context: 'aria-merge-authority', app_id: 15368 },
      { context: 'build-status', app_id: 15368 },
      { context: 'merge-gate', app_id: 15368 },
      { context: 'sens-enterprise-summary', app_id: 15368 },
    ],
    required_context_bindings: [
      'program_id',
      'work_unit_id',
      'successor_work_unit_id',
      'readback_id',
      'final_note_sha256',
      'final_note_identity_sha256',
      'review_dossier_sha256',
      'review_admission_sha256',
      'pull_request_number',
      'base_sha',
      'reviewed_head_sha',
    ],
    invalidation_facts: ['main_sha', 'head_sha', 'required_checks_sha256', 'ruleset_sha256'],
    live_facts: [
      'public_repository',
      'merged_pr',
      'base_head_merge_main',
      'merge_parents',
      'strict_required_checks_success',
      'checks_completed_strictly_before_merge',
      'enforce_admins',
      'ruleset_sha256',
      'current_effective_main_rulesets_no_bypass',
      'unique_final_note_raw_and_natural_identity',
      'real_review_dossier_admission',
      'dossier_base_head_match_provider',
      'operator_observed_strictly_after_merge',
    ],
  },
};
const policyDrift = {
  code: 'AUTHORITY_CONTRACT',
  message: 'delivery policy identity drift',
};
const forbiddenRepositoryMutation = {
  code: 'AUTHORITY_CONTRACT',
  message: 'PLAN delivery rule forbids ledger-close repository mutation',
};

assert.deepEqual(policy.closure, expectedReadback);
const plan = readFileSync(join(planRoot, 'PLAN.md'), 'utf8');
const deliveryAuthority = readFileSync(join(planRoot, 'authority/github-delivery.md'), 'utf8');
const evidenceAuthority = readFileSync(
  join(planRoot, 'authority/verification-evidence.md'),
  'utf8',
);
assert.doesNotMatch(plan, /ledger-close ayrı PR\/commit/u);
assert.doesNotMatch(plan, /review sonrası repository mutasyonu yasaktır/u);
assert.match(plan, /external signed operator readback/u);
assert.match(plan, /reviewed source\/head mutasyonu yasaktır/u);
assert.match(plan, /protected target base'e `MERGE_COMMIT`/u);
const canonicalCommand = evidenceAuthority.match(
  /<!-- d0-delivery-readback-command -->\n\n```sh\n(?<command>[\s\S]*?)\n```/u,
)?.groups?.command;
assert.ok(canonicalCommand, 'canonical D0 delivery readback command is missing');
for (const flag of [
  '--repository-root',
  '--readback-authority-root',
  '--readback-context-envelope',
  '--readback-trust-root',
  '--readback-trust-root-sha256',
  '--review-artifact-root',
  '--review-dossier',
  '--review-context-envelope',
  '--review-trust-root',
  '--review-authority-root',
  '--review-trust-root-sha256',
  '--reviewer-authority-root',
  '--reviewer-authority-bundle',
  '--reviewer-authority-bundle-sha256',
  '--target-authority-root',
  '--target-context-envelope',
  '--target-trust-root',
  '--target-trust-root-sha256',
]) {
  assert.match(canonicalCommand, new RegExp(`(?:^|\\s)${flag}(?:\\s|$)`, 'u'));
}
assert.doesNotMatch(
  canonicalCommand,
  /--(?:program|work-unit|successor|readback-id|base-sha|head-sha)/u,
);
assert.match(deliveryAuthority, /PR `#1393`/u);
assert.match(deliveryAuthority, /executor veya cycle sırası yetkilendirmez/u);
assert.match(deliveryAuthority, /`operator_attested`/u);
assert.match(evidenceAuthority, /gh pr merge --merge --match-head-commit/u);
assert.match(evidenceAuthority, /`--admin`[\s\S]*yasaktır/u);
assert.deepEqual(
  verifyAuthorityContracts(planRoot),
  [],
  'canonical delivery baseline must be clean',
);

withPlanCopy('new-aria-delivery-wrap-', (copy) => {
  replace(
    copy,
    'PLAN.md',
    "izinli tek yöntem merge\ncommit'tir",
    "izinli tek yöntem  \n\nmerge commit'tir",
  );
  assert.deepEqual(verifyAuthorityContracts(copy), [], 'Markdown wrapping must be semantic');
});

for (const [name, mutate, expectedError] of [
  [
    'second repository PR',
    (copy) =>
      mutateJson(copy, 'verification/delivery-policy.json', (value) => {
        value.closure.repository_prs_per_work_unit = 2;
      }),
    policyDrift,
  ],
  [
    'post-review repository mutation',
    (copy) =>
      mutateJson(copy, 'verification/delivery-policy.json', (value) => {
        value.closure.post_review_reviewed_head_mutation = 'ALLOWED';
      }),
    policyDrift,
  ],
  [
    'post-review arbitrary repository effect',
    (copy) =>
      mutateJson(copy, 'verification/delivery-policy.json', (value) => {
        value.closure.post_review_allowed_repository_effect = 'ARBITRARY_COMMIT';
      }),
    policyDrift,
  ],
  [
    'readback contract freshness expansion',
    (copy) =>
      mutateJson(copy, 'verification/delivery-policy.json', (value) => {
        value.closure.readback_contract.max_freshness_seconds = 301;
      }),
    policyDrift,
  ],
  [
    'documented second PR',
    (copy) =>
      replace(copy, 'PLAN.md', 'external signed operator readback', 'ledger-close ayrı PR/commit'),
    forbiddenRepositoryMutation,
  ],
]) {
  withPlanCopy('new-aria-delivery-', (copy) => {
    mutate(copy);
    assert.deepEqual(verifyAuthorityContracts(copy), [expectedError], `${name} must fail closed`);
  });
}

process.stdout.write('PASS delivery-controls\n');
