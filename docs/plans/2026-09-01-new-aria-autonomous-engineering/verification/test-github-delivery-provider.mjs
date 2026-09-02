#!/usr/bin/env node

import assert from 'node:assert/strict';
import { canonicalJson, sha256 } from './lib/canonical.mjs';
import { resolveGitHubDeliveryFacts } from './lib/github-delivery-provider.mjs';
import {
  headSha,
  mergeSha,
  providerResponses,
  required,
  rulesets,
  withFetch,
} from './github-delivery-provider-test-fixture.mjs';

await withFetch(providerResponses(), async (calls) => {
  const facts = await resolveGitHubDeliveryFacts({
    repositorySlug: 'Okan-wqm/aquaculture_platform',
    pullRequestNumber: 1393,
    baseRef: 'main',
    githubToken: 'test-token',
  });
  assert.equal(calls.length, 8, 'all live provider authorities must be queried');
  assert(calls.every(({ options }) => options.headers.authorization === 'Bearer test-token'));
  assert.deepEqual(
    facts.required_checks.map(({ context }) => context),
    required,
  );
  assert.equal(
    facts.required_checks.every(({ conclusion }) => conclusion === 'success'),
    true,
  );
  assert.equal(
    facts.required_checks.every(({ completed_at }) => typeof completed_at === 'string'),
    true,
  );
  assert.equal(facts.pull_merged_at, '2026-09-02T12:00:00Z');
  assert.equal(
    Object.hasOwn(facts, 'bypass_used'),
    false,
    'current GitHub controls must not fabricate historical bypass evidence',
  );
  assert.equal(facts.enforce_admins, true);
  assert.equal(facts.strict_required_checks, true);
  assert.equal(facts.ruleset_sha256, sha256(Buffer.from(canonicalJson(rulesets), 'utf8')));
  assert.equal(facts.main_sha, mergeSha);
  assert.deepEqual(facts.merge_parent_shas, ['1'.repeat(40), headSha]);
});

await withFetch(providerResponses({ effectiveRules: [] }), async (calls) => {
  const facts = await resolveGitHubDeliveryFacts({
    repositorySlug: 'Okan-wqm/aquaculture_platform',
    pullRequestNumber: 1393,
    baseRef: 'main',
  });
  assert.equal(calls.length, 7, 'an empty effective-ruleset list must not fabricate details');
  assert.equal(facts.ruleset_sha256, sha256(Buffer.from('[]', 'utf8')));
  assert.equal(Object.hasOwn(facts, 'bypass_used'), false);
});

for (const [name, mutate, pattern] of [
  ['missing merge time', (value) => delete value.pull.merged_at, /merged_at/u],
  [
    'impossible merge time',
    (value) => {
      value.pull.merged_at = '2026-09-31T12:00:00Z';
    },
    /merged_at/u,
  ],
  [
    'late required check',
    (value) => {
      value.checks.check_runs[0].completed_at = '2026-09-02T12:00:01Z';
    },
    /completed_at/u,
  ],
  [
    'check completion equal to merge',
    (value) => {
      value.checks.check_runs[0].completed_at = value.pull.merged_at;
    },
    /completed_at/u,
  ],
  [
    'missing check completion',
    (value) => {
      delete value.checks.check_runs[0].completed_at;
    },
    /completed_at/u,
  ],
  [
    'duplicate check name from wrong app',
    (value) => {
      value.checks.check_runs.push({
        ...value.checks.check_runs[0],
        id: 999,
        app: { id: 999 },
      });
      value.checks.total_count += 1;
    },
    /ambiguous/u,
  ],
  [
    'paginated checks',
    (value) => {
      value.checkLink = '<https://api.github.com/checks?page=2>; rel="next"';
    },
    /pagination/u,
  ],
  ['truncated checks', (value) => (value.checks.total_count += 1), /incomplete/u],
  [
    'paginated rulesets',
    (value) => {
      value.rulesetLink = '<https://api.github.com/rulesets?page=2>; rel="next"';
    },
    /pagination/u,
  ],
  [
    'ruleset bypass actor',
    (value) => {
      value.ruleset.bypass_actors = [{ actor_id: 7, actor_type: 'Integration' }];
    },
    /bypass/u,
  ],
  ['inactive ruleset', (value) => (value.ruleset.enforcement = 'evaluate'), /active/u],
  ['non-branch ruleset', (value) => (value.ruleset.target = 'tag'), /branch/u],
  [
    'non-applicable ruleset',
    (value) => {
      value.ruleset.conditions.ref_name.include = ['refs/heads/other'];
    },
    /applicable/u,
  ],
  [
    'malformed ruleset',
    (value) => {
      delete value.ruleset.conditions.ref_name;
    },
    /malformed/u,
  ],
  [
    'failed required check',
    (value) => (value.checks.check_runs[0].conclusion = 'failure'),
    /SUCCESS/u,
  ],
  ['wrong check head', (value) => (value.checks.check_runs[0].head_sha = '9'.repeat(40)), /head/u],
  ['admins can bypass', (value) => (value.protection.enforce_admins.enabled = false), /admin/u],
  [
    'unsupported classic pull-request review protection',
    (value) => {
      value.protection.required_pull_request_reviews = {
        bypass_pull_request_allowances: { users: [{ id: 7 }], teams: [], apps: [] },
      };
    },
    /review protection/u,
  ],
  ['loose checks', (value) => (value.protection.required_status_checks.strict = false), /strict/u],
  ['private repository', (value) => (value.repository.private = true), /public/u],
  [
    'coordinated non-main base',
    (value) => {
      value.requestBaseRef = 'evil';
      value.repository.default_branch = 'evil';
      value.pull.base.ref = 'evil';
      value.ref.ref = 'refs/heads/evil';
      value.effectiveRules = [];
    },
    /main/u,
  ],
  [
    'weakened roster',
    (value) => {
      value.protection.required_status_checks.contexts = required.slice(0, 1);
      value.protection.required_status_checks.checks =
        value.protection.required_status_checks.checks.slice(0, 1);
      value.checks.total_count = 1;
      value.checks.check_runs = value.checks.check_runs.slice(0, 1);
    },
    /roster/u,
  ],
]) {
  const values = providerResponses();
  mutate(values);
  await withFetch(values, async () => {
    await assert.rejects(
      resolveGitHubDeliveryFacts({
        repositorySlug: 'Okan-wqm/aquaculture_platform',
        pullRequestNumber: 1393,
        baseRef: values.requestBaseRef,
      }),
      pattern,
      `${name} accepted`,
    );
  });
}

process.stdout.write('PASS github-delivery-provider live-facts=14 mutants=22\n');
