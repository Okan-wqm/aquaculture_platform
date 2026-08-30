#!/usr/bin/env node

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'Okan-wqm/aquaculture_platform';
const REPOSITORY_ID = 1132698735;
const PROTECTED_REF = 'refs/heads/main';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]{0,19}$/;
const WORKFLOW_REF_PATTERN =
  /^Okan-wqm\/aquaculture_platform\/(\.github\/workflows\/(?:aria-daily-report|finding-registry-authority|finding-state-sweep|rule-health-report)\.yml)@refs\/heads\/main$/;
const TRUSTED_EVENTS = new Set(['schedule', 'workflow_dispatch']);

function requireEnvironment(env, name, maxBytes = 1024) {
  const value = env[name];
  if (
    !value ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw new Error(`${name} is missing or non-canonical`);
  }
  return value;
}

function positiveSafeInteger(value, field) {
  const text = String(value);
  if (!POSITIVE_INTEGER_PATTERN.test(text)) {
    throw new Error(`${field} must be a positive integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${field} exceeds the safe integer range`);
  }
  return parsed;
}

function record(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function canonicalCreatedAt(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new Error('Actions run created_at is not a canonical UTC second');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().replace('.000Z', 'Z') !== value) {
    throw new Error('Actions run created_at is not a real UTC instant');
  }
  return value;
}

export function expectedRunIdentity(env) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_REPOSITORY_ID !== String(REPOSITORY_ID) ||
    env.GITHUB_REF !== PROTECTED_REF ||
    env.GITHUB_REF_PROTECTED !== 'true'
  ) {
    throw new Error('Run clock requires the canonical protected-main GitHub Actions context');
  }
  const event = requireEnvironment(env, 'GITHUB_EVENT_NAME', 64);
  if (!TRUSTED_EVENTS.has(event)) {
    throw new Error(`Run clock does not trust event ${event}`);
  }
  const workflowRef = requireEnvironment(env, 'GITHUB_WORKFLOW_REF', 512);
  const workflowMatch = WORKFLOW_REF_PATTERN.exec(workflowRef);
  if (!workflowMatch?.[1]) {
    throw new Error('Run clock workflow_ref is outside the automation publication policy');
  }
  const headSha = requireEnvironment(env, 'GITHUB_SHA', 40);
  if (!SHA_PATTERN.test(headSha)) {
    throw new Error('GITHUB_SHA must be a full lowercase Git SHA');
  }
  return {
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    runId: positiveSafeInteger(requireEnvironment(env, 'GITHUB_RUN_ID', 32), 'GITHUB_RUN_ID'),
    runAttempt: positiveSafeInteger(
      requireEnvironment(env, 'GITHUB_RUN_ATTEMPT', 32),
      'GITHUB_RUN_ATTEMPT',
    ),
    event,
    workflowPath: workflowMatch[1],
    headSha,
  };
}

export function validateRunClockResponse(value, expected) {
  const run = record(value, 'Actions run');
  const repository = record(run.repository, 'Actions run repository');
  const headRepository = record(run.head_repository, 'Actions run head_repository');
  const mismatches = [];
  if (positiveSafeInteger(run.id, 'Actions run id') !== expected.runId) {
    mismatches.push('run id');
  }
  if (positiveSafeInteger(run.run_attempt, 'Actions run attempt') !== expected.runAttempt) {
    mismatches.push('run attempt');
  }
  if (run.event !== expected.event) mismatches.push('event');
  if (run.head_sha !== expected.headSha) mismatches.push('head sha');
  if (run.head_branch !== 'main') mismatches.push('head branch');
  if (run.path !== expected.workflowPath) mismatches.push('workflow path');
  if (
    positiveSafeInteger(repository.id, 'Actions run repository id') !== expected.repositoryId ||
    repository.full_name !== expected.repository
  ) {
    mismatches.push('repository');
  }
  if (
    positiveSafeInteger(headRepository.id, 'Actions run head repository id') !==
      expected.repositoryId ||
    headRepository.full_name !== expected.repository
  ) {
    mismatches.push('head repository');
  }
  if (mismatches.length > 0) {
    throw new Error(`Actions run identity differs from context: ${mismatches.join(', ')}`);
  }
  const createdAt = canonicalCreatedAt(run.created_at);
  return {
    createdAt,
    date: createdAt.slice(0, 10),
    epochSeconds: Math.floor(new Date(createdAt).valueOf() / 1000),
  };
}

async function readBoundedJson(response) {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    throw new Error('Actions run API declared an oversized response');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Actions run API response has no readable body');
  }
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Actions run API response exceeded its byte budget');
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    throw new Error('Actions run API returned invalid JSON');
  }
}

export async function resolveGitHubRunClock(env, fetchImpl = fetch) {
  const expected = expectedRunIdentity(env);
  const token = requireEnvironment(env, 'GITHUB_TOKEN', 16 * 1024);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref();
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${REPOSITORY}/actions/runs/${String(expected.runId)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'aqua-automation-run-clock-v1',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error',
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`Actions run API returned HTTP ${String(response.status)}`);
    }
    return validateRunClockResponse(await readBoundedJson(response), expected);
  } finally {
    clearTimeout(timeout);
  }
}

function writeOutputs(outputPath, clock) {
  const descriptor = openSync(
    outputPath,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
  );
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error('GITHUB_OUTPUT must be a regular file');
    }
    writeFileSync(
      descriptor,
      `created_at=${clock.createdAt}\ndate=${clock.date}\nepoch_seconds=${String(
        clock.epochSeconds,
      )}\n`,
    );
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function main() {
  const outputPath = requireEnvironment(process.env, 'GITHUB_OUTPUT', 4096);
  const clock = await resolveGitHubRunClock(process.env);
  writeOutputs(outputPath, clock);
  process.stdout.write(
    `Immutable Actions run clock: ${clock.createdAt} (run ${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT})\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `resolve-github-run-clock: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
