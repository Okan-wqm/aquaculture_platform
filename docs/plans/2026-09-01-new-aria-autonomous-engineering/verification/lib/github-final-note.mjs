import { canonicalJson, parseStrictJson, sha256 } from './canonical.mjs';

const apiOrigin = 'https://api.github.com';
const marker = '<!-- new-aria-d0-final-note-v1 -->';
const exactSha = /^[a-f0-9]{40}$/u;
const exactDigest = /^[a-f0-9]{64}$/u;
const exactUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const noteKeys = [
  'schema_version',
  'contract_id',
  'program_id',
  'work_unit_id',
  'successor_work_unit_id',
  'pull_request_number',
  'readback_id',
  'reviewed_head_sha',
  'review_dossier_sha256',
  'review_admission_sha256',
  'unresolved_load_bearing_findings',
  'status',
];
const expectedKeys = [
  'program_id',
  'work_unit_id',
  'successor_work_unit_id',
  'pull_request_number',
  'readback_id',
  'reviewed_head_sha',
  'review_dossier_sha256',
  'review_admission_sha256',
];

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function timestamp(value, label) {
  const milliseconds = typeof value === 'string' && exactUtc.test(value) ? Date.parse(value) : NaN;
  const canonical =
    typeof value === 'string' && value.length === 20 ? value.replace('Z', '.000Z') : value;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== canonical) {
    throw new Error(`${label} is invalid`);
  }
  return milliseconds;
}

function requestHeaders(token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2026-03-10',
    'user-agent': 'new-aria-delivery-readback',
  };
  if (typeof token === 'string' && token.length > 0) headers.authorization = `Bearer ${token}`;
  return headers;
}

function nextPage(link, currentPage) {
  if (link === null) return null;
  if (typeof link !== 'string') throw new Error('GitHub comment pagination metadata is invalid');
  const next = link.split(',').find((part) => /;\s*rel="[^"]*\bnext\b[^"]*"\s*$/iu.test(part));
  if (!next) return null;
  const match = next.match(/^\s*<(?<url>[^>]+)>/u);
  if (!match?.groups?.url) throw new Error('GitHub comment pagination metadata is invalid');
  const url = new URL(match.groups.url);
  const page = Number(url.searchParams.get('page'));
  if (
    url.origin !== apiOrigin ||
    url.searchParams.get('per_page') !== '100' ||
    !Number.isSafeInteger(page) ||
    page !== currentPage + 1
  ) {
    throw new Error('GitHub comment pagination sequence is invalid');
  }
  return page;
}

async function readCommentPage(repositorySlug, pullRequestNumber, token, page) {
  const url = `${apiOrigin}/repos/${repositorySlug}/issues/${pullRequestNumber}/comments?per_page=100&page=${page}`;
  const response = await globalThis.fetch(url, { method: 'GET', headers: requestHeaders(token) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for final-note comments`);
  if (!response.headers || typeof response.headers.get !== 'function') {
    throw new Error('GitHub comment pagination metadata is unavailable');
  }
  const comments = await response.json();
  if (!Array.isArray(comments) || comments.length > 100) {
    throw new Error('GitHub comment page is invalid');
  }
  return { comments, next: nextPage(response.headers.get('link'), page) };
}

function appendUniqueComments(target, seenIds, comments) {
  for (const comment of comments) {
    if (!Number.isSafeInteger(comment?.id) || seenIds.has(comment.id)) {
      throw new Error('GitHub comment identity is invalid or duplicated');
    }
    seenIds.add(comment.id);
    target.push(comment);
  }
}

async function commentPages(repositorySlug, pullRequestNumber, token) {
  const collected = [];
  const seenIds = new Set();
  let page = 1;
  while (page <= 100) {
    const result = await readCommentPage(repositorySlug, pullRequestNumber, token, page);
    appendUniqueComments(collected, seenIds, result.comments);
    if (result.next === null) return collected;
    page = result.next;
  }
  throw new Error('GitHub comment pagination exceeds the bounded limit');
}

function parseNote(body) {
  if (typeof body !== 'string' || !body.startsWith(`${marker}\n`) || !body.endsWith('\n')) {
    throw new Error('final note body is not canonical');
  }
  const note = parseStrictJson(body.slice(marker.length + 1, -1));
  if (!exactKeys(note, noteKeys) || body !== `${marker}\n${canonicalJson(note)}\n`) {
    throw new Error('final note schema or canonical encoding is invalid');
  }
  return note;
}

function validateAuthor(comment) {
  const user = comment.user;
  if (
    comment.author_association !== 'OWNER' ||
    user?.login !== 'Okan-wqm' ||
    user?.id !== 77401788 ||
    user?.node_id !== 'MDQ6VXNlcjc3NDAxNzg4' ||
    user?.type !== 'User'
  ) {
    throw new Error('final note GitHub author identity is not trusted');
  }
}

function validateComment(comment, mergedAt) {
  validateAuthor(comment);
  if (
    typeof comment.node_id !== 'string' ||
    comment.node_id.length === 0 ||
    comment.html_url !==
      `https://github.com/Okan-wqm/aquaculture_platform/pull/1393#issuecomment-${comment.id}`
  ) {
    throw new Error('final note comment natural identity is invalid');
  }
  if (comment.created_at !== comment.updated_at)
    throw new Error('final note comment is not immutable');
  if (
    timestamp(comment.created_at, 'final note created_at') >= timestamp(mergedAt, 'pull merged_at')
  ) {
    throw new Error('final note must exist strictly before merge');
  }
}

function validateExpectedContext(note, expected) {
  if (!exactKeys(expected, expectedKeys))
    throw new Error('final note expected context is incomplete');
  for (const key of expectedKeys) {
    if (note[key] !== expected[key]) throw new Error('final note context mismatch');
  }
}

function validateNoteIdentity(note) {
  if (
    note.schema_version !== '1.0.0' ||
    note.contract_id !== 'new-aria-d0-final-note-v1' ||
    note.program_id !== 'new-aria-autonomous-engineering' ||
    note.work_unit_id !== 'D0' ||
    note.successor_work_unit_id !== 'S01' ||
    note.pull_request_number !== 1393
  ) {
    throw new Error('final note D0 authority contract mismatch');
  }
}

function validateNoteArtifacts(note) {
  if (
    note.readback_id !== `d0-readback-${note.reviewed_head_sha.slice(0, 16)}` ||
    !exactSha.test(note.reviewed_head_sha) ||
    !exactDigest.test(note.review_dossier_sha256) ||
    !exactDigest.test(note.review_admission_sha256)
  ) {
    throw new Error('final note D0 authority contract mismatch');
  }
}

function validateNoteOutcome(note) {
  if (
    !Array.isArray(note.unresolved_load_bearing_findings) ||
    note.unresolved_load_bearing_findings.length !== 0 ||
    note.status !== 'ACCEPTED'
  ) {
    throw new Error('final note D0 authority contract mismatch');
  }
}

function validateNote(note, expected) {
  validateExpectedContext(note, expected);
  validateNoteIdentity(note);
  validateNoteArtifacts(note);
  validateNoteOutcome(note);
}

export async function resolveGitHubFinalNote(options) {
  const comments = await commentPages(
    options.repositorySlug,
    options.pullRequestNumber,
    options.githubToken,
  );
  const candidates = comments.filter((comment) =>
    typeof comment?.body === 'string' ? comment.body.startsWith(marker) : false,
  );
  if (candidates.length !== 1) throw new Error('exactly one D0 final note comment is required');
  const comment = candidates[0];
  const note = parseNote(comment.body);
  validateComment(comment, options.mergedAt);
  validateNote(note, options.expected);
  const identity = {
    id: comment.id,
    node_id: comment.node_id,
    html_url: comment.html_url,
    created_at: comment.created_at,
    author_id: comment.user.id,
    author_node_id: comment.user.node_id,
  };
  return {
    note,
    final_note_sha256: sha256(Buffer.from(comment.body, 'utf8')),
    final_note_identity_sha256: sha256(Buffer.from(canonicalJson(identity), 'utf8')),
  };
}
