import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expectedRunIdentity,
  resolveGitHubRunClock,
  validateRunClockResponse,
} from './resolve-github-run-clock.mjs';

const ENV = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'Okan-wqm/aquaculture_platform',
  GITHUB_REPOSITORY_ID: '1132698735',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REF_PROTECTED: 'true',
  GITHUB_EVENT_NAME: 'schedule',
  GITHUB_WORKFLOW_REF:
    'Okan-wqm/aquaculture_platform/.github/workflows/aria-daily-report.yml@refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '9001',
  GITHUB_RUN_ATTEMPT: '2',
};

function response(overrides = {}) {
  return {
    id: 9001,
    run_attempt: 2,
    event: 'schedule',
    head_sha: 'a'.repeat(40),
    head_branch: 'main',
    path: '.github/workflows/aria-daily-report.yml',
    created_at: '2026-07-30T06:00:03Z',
    repository: {
      id: 1132698735,
      full_name: 'Okan-wqm/aquaculture_platform',
    },
    head_repository: {
      id: 1132698735,
      full_name: 'Okan-wqm/aquaculture_platform',
    },
    ...overrides,
  };
}

test('binds one immutable created_at clock to the exact protected-main run', () => {
  const expected = expectedRunIdentity(ENV);
  assert.deepEqual(validateRunClockResponse(response(), expected), {
    createdAt: '2026-07-30T06:00:03Z',
    date: '2026-07-30',
    epochSeconds: 1785391203,
  });
});

test('supports the other policy-owned report workflow and workflow_dispatch', () => {
  const expected = expectedRunIdentity({
    ...ENV,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF:
      'Okan-wqm/aquaculture_platform/.github/workflows/rule-health-report.yml@refs/heads/main',
  });
  assert.equal(expected.workflowPath, '.github/workflows/rule-health-report.yml');
});

test('uses the same immutable clock contract for both finding registry writers', () => {
  for (const workflow of ['finding-registry-authority', 'finding-state-sweep']) {
    const expected = expectedRunIdentity({
      ...ENV,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_WORKFLOW_REF: `Okan-wqm/aquaculture_platform/.github/workflows/${workflow}.yml@refs/heads/main`,
    });
    assert.equal(expected.workflowPath, `.github/workflows/${workflow}.yml`);
  }
});

test('rejects mutable, foreign, and attempt-drifted run coordinates', () => {
  const expected = expectedRunIdentity(ENV);
  for (const invalid of [
    response({ run_attempt: 3 }),
    response({ head_sha: 'b'.repeat(40) }),
    response({ head_branch: 'feature' }),
    response({ path: '.github/workflows/other.yml' }),
    response({
      repository: { id: 1, full_name: 'attacker/repository' },
    }),
    response({
      head_repository: { id: 1, full_name: 'attacker/repository' },
    }),
  ]) {
    assert.throws(() => validateRunClockResponse(invalid, expected), /identity differs/);
  }
});

test('rejects invalid clocks and non-policy execution contexts', () => {
  const expected = expectedRunIdentity(ENV);
  assert.throws(
    () => validateRunClockResponse(response({ created_at: '2026-02-30T06:00:03Z' }), expected),
    /real UTC instant/,
  );
  assert.throws(
    () => expectedRunIdentity({ ...ENV, GITHUB_REF_PROTECTED: 'false' }),
    /protected-main/,
  );
  assert.throws(
    () =>
      expectedRunIdentity({
        ...ENV,
        GITHUB_WORKFLOW_REF:
          'Okan-wqm/aquaculture_platform/.github/workflows/ci-full.yml@refs/heads/main',
      }),
    /outside the automation publication policy/,
  );
  assert.throws(
    () => expectedRunIdentity({ ...ENV, GITHUB_EVENT_NAME: 'pull_request' }),
    /does not trust event/,
  );
});

test('reads only the exact run endpoint with the bounded default token', async () => {
  let observedUrl = '';
  let observedInit;
  const clock = await resolveGitHubRunClock(
    { ...ENV, GITHUB_TOKEN: 'unit-test-token' },
    async (url, init) => {
      observedUrl = String(url);
      observedInit = init;
      const body = JSON.stringify(response());
      return new Response(body, {
        status: 200,
        headers: { 'content-length': String(Buffer.byteLength(body)) },
      });
    },
  );
  assert.equal(
    observedUrl,
    'https://api.github.com/repos/Okan-wqm/aquaculture_platform/actions/runs/9001',
  );
  assert.equal(observedInit?.method, 'GET');
  assert.equal(observedInit?.redirect, 'error');
  assert.equal(observedInit?.headers?.Authorization, 'Bearer unit-test-token');
  assert.deepEqual(clock, {
    createdAt: '2026-07-30T06:00:03Z',
    date: '2026-07-30',
    epochSeconds: 1785391203,
  });
});

test('fails closed on non-success and oversized API responses', async () => {
  const env = { ...ENV, GITHUB_TOKEN: 'unit-test-token' };
  await assert.rejects(
    resolveGitHubRunClock(env, async () => new Response('{}', { status: 403 })),
    /HTTP 403/,
  );
  await assert.rejects(
    resolveGitHubRunClock(
      env,
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(1024 * 1024 + 1) },
        }),
    ),
    /oversized response/,
  );
});
