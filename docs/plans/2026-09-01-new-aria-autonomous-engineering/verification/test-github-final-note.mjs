#!/usr/bin/env node

import assert from 'node:assert/strict';
import { canonicalJson } from './lib/canonical.mjs';
import { resolveGitHubFinalNote } from './lib/github-final-note.mjs';

const mergedAt = '2026-09-02T12:00:00.000Z';
const reviewedHeadSha = '2'.repeat(40);
const expected = {
  program_id: 'new-aria-autonomous-engineering',
  work_unit_id: 'D0',
  successor_work_unit_id: 'S01',
  pull_request_number: 1393,
  readback_id: `d0-readback-${reviewedHeadSha.slice(0, 16)}`,
  reviewed_head_sha: reviewedHeadSha,
  review_dossier_sha256: '4'.repeat(64),
  review_admission_sha256: '5'.repeat(64),
};

function body(overrides = {}) {
  const note = {
    schema_version: '1.0.0',
    contract_id: 'new-aria-d0-final-note-v1',
    ...expected,
    unresolved_load_bearing_findings: [],
    status: 'ACCEPTED',
    ...overrides,
  };
  return `<!-- new-aria-d0-final-note-v1 -->\n${canonicalJson(note)}\n`;
}

function comment(overrides = {}) {
  return {
    id: 9001,
    node_id: 'IC_kwDOQ4Ocb86gZGVhZA',
    html_url: 'https://github.com/Okan-wqm/aquaculture_platform/pull/1393#issuecomment-9001',
    body: body(),
    created_at: '2026-09-02T11:50:00Z',
    updated_at: '2026-09-02T11:50:00Z',
    author_association: 'OWNER',
    user: {
      login: 'Okan-wqm',
      id: 77401788,
      node_id: 'MDQ6VXNlcjc3NDAxNzg4',
      type: 'User',
    },
    ...overrides,
  };
}

function response(value, link) {
  const headers = new Headers();
  if (link) headers.set('link', link);
  return { ok: true, status: 200, headers, json: async () => value };
}

async function withComments(pages, run) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const page = new URL(url).searchParams.get('page');
    const fixture = pages[Number(page) - 1];
    if (!fixture) throw new Error(`unexpected page ${page}`);
    return response(fixture.comments, fixture.link);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const firstPage = Array.from({ length: 100 }, (_, index) =>
  comment({ id: index + 1, body: 'noise' }),
);
const nextLink =
  '<https://api.github.com/repositories/1132698735/issues/1393/comments?per_page=100&page=2>; rel="next"';
await withComments(
  [{ comments: firstPage, link: nextLink }, { comments: [comment()] }],
  async (calls) => {
    const result = await resolveGitHubFinalNote({
      repositorySlug: 'Okan-wqm/aquaculture_platform',
      pullRequestNumber: 1393,
      mergedAt,
      expected,
    });
    assert.equal(calls.length, 2, 'all final-note comment pages must be read');
    assert(
      calls.every(({ options }) => options.headers['x-github-api-version'] === '2026-03-10'),
      'final-note requests must use the authority-pinned GitHub API version',
    );
    assert.equal(result.note.readback_id, expected.readback_id);
    assert.match(result.final_note_sha256, /^[a-f0-9]{64}$/u);
    assert.match(result.final_note_identity_sha256, /^[a-f0-9]{64}$/u);
  },
);

for (const [name, comments, pattern] of [
  ['missing', [], /exactly one/u],
  ['duplicate', [comment(), comment({ id: 9002 })], /exactly one/u],
  ['edited', [comment({ updated_at: '2026-09-02T11:51:00Z' })], /immutable/u],
  ['late', [comment({ created_at: mergedAt, updated_at: mergedAt })], /before merge/u],
  [
    'impossible timestamp',
    [comment({ created_at: '2026-09-31T11:50:00Z', updated_at: '2026-09-31T11:50:00Z' })],
    /invalid/u,
  ],
  ['wrong author', [comment({ user: { ...comment().user, id: 1 } })], /author/u],
  ['wrong association', [comment({ author_association: 'CONTRIBUTOR' })], /author/u],
  ['wrong head', [comment({ body: body({ reviewed_head_sha: '9'.repeat(40) }) })], /context/u],
  [
    'wrong admission',
    [comment({ body: body({ review_admission_sha256: '6'.repeat(64) }) })],
    /context/u,
  ],
  ['noncanonical', [comment({ body: `${body().trimEnd()} ` })], /canonical/u],
]) {
  await withComments([{ comments }], async () => {
    await assert.rejects(
      resolveGitHubFinalNote({
        repositorySlug: 'Okan-wqm/aquaculture_platform',
        pullRequestNumber: 1393,
        mergedAt,
        expected,
      }),
      pattern,
      `${name} final note accepted`,
    );
  });
}

await withComments(
  [{ comments: firstPage, link: nextLink.replace('page=2', 'page=3') }],
  async () => {
    await assert.rejects(
      resolveGitHubFinalNote({
        repositorySlug: 'Okan-wqm/aquaculture_platform',
        pullRequestNumber: 1393,
        mergedAt,
        expected,
      }),
      /pagination/u,
    );
  },
);

process.stdout.write('PASS github-final-note pages=2 mutants=11\n');
