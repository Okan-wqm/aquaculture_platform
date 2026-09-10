export const headSha = '2'.repeat(40);
export const mergeSha = '3'.repeat(40);
export const required = [
  'aria-merge-authority',
  'build-status',
  'merge-gate',
  'sens-enterprise-summary',
];
export const rulesets = [
  {
    id: 91,
    name: 'main protection',
    target: 'branch',
    source_type: 'Repository',
    source: 'Okan-wqm/aquaculture_platform',
    enforcement: 'active',
    bypass_actors: [],
    current_user_can_bypass: 'never',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [{ type: 'non_fast_forward' }],
  },
];

const protection = {
  required_status_checks: {
    strict: true,
    contexts: required,
    checks: required.map((context) => ({ context, app_id: 15368 })),
  },
  enforce_admins: { enabled: true },
};

function response(body, link) {
  const headers = new Headers();
  if (link) headers.set('link', link);
  return { ok: true, status: 200, headers, json: async () => body };
}

export function providerResponses(overrides = {}) {
  return {
    repository: {
      id: 1132698735,
      node_id: 'R_kgDOQ4Ocbw',
      full_name: 'Okan-wqm/aquaculture_platform',
      private: false,
      default_branch: 'main',
    },
    pull: {
      number: 1393,
      html_url: 'https://github.com/Okan-wqm/aquaculture_platform/pull/1393',
      state: 'closed',
      merged: true,
      merged_at: '2026-09-02T12:00:00Z',
      base: { ref: 'main', sha: '1'.repeat(40) },
      head: { sha: headSha },
      merge_commit_sha: mergeSha,
    },
    ref: { ref: 'refs/heads/main', object: { type: 'commit', sha: mergeSha } },
    commit: {
      sha: mergeSha,
      parents: [{ sha: '1'.repeat(40) }, { sha: headSha }],
    },
    protection: structuredClone(protection),
    checks: {
      total_count: required.length,
      check_runs: required.map((name, index) => ({
        id: 100 + index,
        name,
        head_sha: headSha,
        status: 'completed',
        conclusion: 'success',
        completed_at: `2026-09-02T11:${String(50 + index).padStart(2, '0')}:00Z`,
        app: { id: 15368 },
      })),
    },
    effectiveRules: ['non_fast_forward', 'deletion'].map((type) => ({
      type,
      ruleset_source_type: 'Repository',
      ruleset_source: 'Okan-wqm/aquaculture_platform',
      ruleset_id: 91,
    })),
    ruleset: structuredClone(rulesets[0]),
    checkLink: undefined,
    rulesetLink: undefined,
    requestBaseRef: 'main',
    ...overrides,
  };
}

export async function withFetch(values, run) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    calls.push({ url: target, options });
    if (target.endsWith('/pulls/1393')) return response(values.pull);
    if (target.includes('/git/ref/heads/')) return response(values.ref);
    if (target.endsWith(`/commits/${mergeSha}`)) return response(values.commit);
    if (target.includes('/branches/') && target.endsWith('/protection')) {
      return response(values.protection);
    }
    if (target.includes('/check-runs?')) return response(values.checks, values.checkLink);
    if (target.endsWith('/rulesets/91')) return response(values.ruleset);
    if (target.includes('/rules/branches/')) {
      return response(values.effectiveRules, values.rulesetLink);
    }
    if (target.endsWith('/aquaculture_platform')) return response(values.repository);
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = previous;
  }
}
