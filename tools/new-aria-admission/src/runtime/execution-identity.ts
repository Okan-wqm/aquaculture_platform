import { createHash } from 'node:crypto';

import { requireIdentifier } from '../kernel/identifiers';

const sha64 = /^[a-f0-9]{64}$/u;
const ARGUMENT_POLICY = Object.freeze({
  max_count: 62,
  max_item_bytes: 4_096,
  max_total_bytes: 30 * 1_024,
});
const NEGATIVE_CONTROL_SUFFIX = Object.freeze({
  count: 2,
  max_bytes: Buffer.byteLength('--negative-control', 'utf8') + 128,
});

export interface ExecutionIdentityRequest {
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly tool_id: string;
  readonly input_reference_bundle_sha256: string;
  readonly input_envelope_sha256: string;
  readonly input_object_sha256s: readonly string[];
}

export interface ExecutionIdentity extends ExecutionIdentityRequest {
  readonly logical_cwd: string;
  readonly logical_cwd_sha256: string;
}

export function canonicalExecutionCwd(repositoryId: string, workspaceId: string): string {
  const repository = requireIdentifier(repositoryId, 'execution repository identifier');
  const workspace = requireIdentifier(workspaceId, 'execution workspace identifier');
  return `workspace://${encodeURIComponent(repository)}/${encodeURIComponent(workspace)}`;
}

function safeText(value: string): boolean {
  if (value.length === 0) return false;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (
      point === undefined ||
      point < 0x20 ||
      (point >= 0x7f && point <= 0x9f) ||
      point === 0x061c ||
      point === 0x200e ||
      point === 0x200f ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069)
    ) {
      return false;
    }
  }
  return true;
}

export function snapshotExecutionArguments(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > ARGUMENT_POLICY.max_count) {
    throw new TypeError('verifier arguments exceed the count bound');
  }
  let totalBytes = 0;
  for (const item of value) {
    if (typeof item !== 'string') throw new TypeError('verifier arguments must be safe text');
    const itemBytes = Buffer.byteLength(item, 'utf8');
    totalBytes += itemBytes;
    if (
      itemBytes > ARGUMENT_POLICY.max_item_bytes ||
      totalBytes > ARGUMENT_POLICY.max_total_bytes
    ) {
      throw new TypeError('verifier arguments exceed the byte bound');
    }
    if (!safeText(item)) throw new TypeError('verifier arguments must be non-empty safe text');
  }
  return Object.freeze(value.map((item) => String(item)));
}

export function snapshotBaseExecutionArguments(value: unknown): readonly string[] {
  const args = snapshotExecutionArguments(value);
  const totalBytes = args.reduce((total, item) => total + Buffer.byteLength(item, 'utf8'), 0);
  if (
    args.length > ARGUMENT_POLICY.max_count - NEGATIVE_CONTROL_SUFFIX.count ||
    totalBytes > ARGUMENT_POLICY.max_total_bytes - NEGATIVE_CONTROL_SUFFIX.max_bytes
  ) {
    throw new TypeError('verifier arguments do not reserve negative-control suffix headroom');
  }
  return args;
}

export function resolveExecutionIdentity(request: ExecutionIdentityRequest): ExecutionIdentity {
  const repositoryId = requireIdentifier(request.repository_id, 'execution repository identifier');
  const workspaceId = requireIdentifier(request.workspace_id, 'execution workspace identifier');
  const toolId = requireIdentifier(request.tool_id, 'execution tool identifier');
  if (
    !sha64.test(request.input_reference_bundle_sha256) ||
    !sha64.test(request.input_envelope_sha256) ||
    request.input_object_sha256s.length === 0 ||
    request.input_object_sha256s.some((sha256) => !sha64.test(sha256))
  ) {
    throw new TypeError('execution input digest is invalid');
  }
  const logicalCwd = canonicalExecutionCwd(repositoryId, workspaceId);
  return Object.freeze({
    repository_id: repositoryId,
    workspace_id: workspaceId,
    tool_id: toolId,
    input_reference_bundle_sha256: request.input_reference_bundle_sha256,
    input_envelope_sha256: request.input_envelope_sha256,
    input_object_sha256s: Object.freeze([...request.input_object_sha256s]),
    logical_cwd: logicalCwd,
    logical_cwd_sha256: createHash('sha256').update(Buffer.from(logicalCwd)).digest('hex'),
  });
}
