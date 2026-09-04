// The instance manifest, actually applied.
//
// WHY: `arias/<id>/aria.manifest.json` declares what an instance may do —
// `runtime.allow_actions`, `runtime.profile_ceiling`, and a pointer to an
// approval policy naming which human role owns which action class. MEASURED on
// 2026-09-04: nothing loads any of it. `arias/derive.mjs` copies the files and
// rewrites identifiers; `arias/instances.test.mjs` asserts only that the policy
// keys exist. A policy no code reads is not a policy — it is a document that
// makes a reader believe a gate exists.
//
// WHAT: loads the manifest named by ARIA_INSTANCE_MANIFEST plus the approval
// policy it points at, and exposes them to the server. Two rules govern the
// result, both deliberate:
//
//   1. The manifest may only NARROW. `allow_actions: false` turns mutating
//      endpoints off even when the operator's environment enabled them; it can
//      never turn them on. An instance file that travels with the product must
//      not be able to grant more authority than the person running it did.
//   2. It fails CLOSED. If the variable names a manifest that is missing,
//      unparseable, or shaped wrong, the server refuses to start. The
//      alternative — carrying on with the policy silently absent — is exactly
//      the state this module was written to end.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { ConfigError } from './config.ts';

/** The action classes an approval policy may govern, as the legal instance declares them. */
export interface ApprovalGate {
  readonly actionClass: string;
  readonly description: string;
  /** The role that must approve, or null when the class is automatic. */
  readonly requiresRole: string | null;
  readonly auto: boolean;
}

export interface InstancePolicy {
  /** Path the policy was loaded from, for the console to show its provenance. */
  readonly manifestPath: string;
  readonly instanceId: string;
  readonly displayName: string;
  /** Highest runtime profile this instance may reach; the console displays it. */
  readonly profileCeiling: string | null;
  /** Whether the instance file permits mutating actions at all. */
  readonly allowActions: boolean;
  readonly approvalPolicyPath: string | null;
  readonly gates: ReadonlyArray<ApprovalGate>;
}

function fail(detail: string): never {
  throw new ConfigError('ARIA_INSTANCE_MANIFEST', detail);
}

function readJson(path: string, label: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    fail(`${label} is unreadable at ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`${label} at ${path} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(`${label} at ${path} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function readObject(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail(`${key} must be an object`);
  return value as Record<string, unknown>;
}

function readRequiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') fail(`${key} must be a non-empty string`);
  return value.trim();
}

function parseGates(policy: Record<string, unknown>, path: string): ApprovalGate[] {
  const raw = policy['gates'];
  if (!Array.isArray(raw)) fail(`approval policy at ${path} must declare a gates array`);
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(`approval policy gates[${index}] must be an object`);
    }
    const gate = entry as Record<string, unknown>;
    const actionClass = gate['action_class'];
    if (typeof actionClass !== 'string' || actionClass.trim() === '') {
      fail(`approval policy gates[${index}].action_class must be a non-empty string`);
    }
    const requiresRoleRaw = gate['requires_role'];
    if (requiresRoleRaw !== null && requiresRoleRaw !== undefined && typeof requiresRoleRaw !== 'string') {
      fail(`approval policy gates[${index}].requires_role must be a string or null`);
    }
    const auto = gate['auto'];
    if (typeof auto !== 'boolean') {
      fail(`approval policy gates[${index}].auto must be a boolean`);
    }
    const requiresRole = typeof requiresRoleRaw === 'string' && requiresRoleRaw.trim() !== '' ? requiresRoleRaw.trim() : null;
    // A gate that names no role and is not automatic would be unenforceable in
    // both directions: nothing may do it and nobody may approve it.
    if (requiresRole === null && !auto) {
      fail(`approval policy gates[${index}] (${actionClass}) is neither automatic nor owned by a role`);
    }
    if (requiresRole !== null && auto) {
      fail(`approval policy gates[${index}] (${actionClass}) is automatic yet names an approving role`);
    }
    const description = gate['description'];
    return {
      actionClass: actionClass.trim(),
      description: typeof description === 'string' ? description : '',
      requiresRole,
      auto,
    };
  });
}

/**
 * Loads the instance policy, or returns null when no manifest is configured.
 * A configured-but-broken manifest throws: fail closed, never fall through.
 */
export function loadInstancePolicy(env: NodeJS.ProcessEnv = process.env): InstancePolicy | null {
  const raw = env['ARIA_INSTANCE_MANIFEST'];
  if (raw === undefined || raw.trim() === '') return null;
  const manifestPath = resolve(raw.trim());
  const manifest = readJson(manifestPath, 'instance manifest');
  const instanceId = readRequiredString(manifest, 'id');
  const displayName = typeof manifest['display_name'] === 'string' ? (manifest['display_name'] as string) : instanceId;

  const runtime = readObject(manifest, 'runtime');
  let profileCeiling: string | null = null;
  let allowActions = true;
  if (runtime !== null) {
    const ceiling = runtime['profile_ceiling'];
    if (ceiling !== undefined && ceiling !== null) {
      if (typeof ceiling !== 'string' || ceiling.trim() === '') fail('runtime.profile_ceiling must be a non-empty string');
      profileCeiling = ceiling.trim();
    }
    const allow = runtime['allow_actions'];
    if (allow !== undefined && allow !== null) {
      if (typeof allow !== 'boolean') fail('runtime.allow_actions must be a boolean');
      allowActions = allow;
    }
  }

  const policies = readObject(manifest, 'policies');
  let approvalPolicyPath: string | null = null;
  let gates: ApprovalGate[] = [];
  if (policies !== null) {
    const approval = policies['approval'];
    if (approval !== undefined && approval !== null) {
      if (typeof approval !== 'string' || approval.trim() === '') fail('policies.approval must be a non-empty path');
      // The pointer is relative to the manifest, so an instance directory stays
      // movable as a unit.
      approvalPolicyPath = resolve(dirname(manifestPath), approval.trim());
      gates = parseGates(readJson(approvalPolicyPath, 'approval policy'), approvalPolicyPath);
    }
  }

  return Object.freeze({
    manifestPath,
    instanceId,
    displayName,
    profileCeiling,
    allowActions,
    approvalPolicyPath,
    gates: Object.freeze(gates),
  });
}

/**
 * The effective action permission. The environment grants; the instance file may
 * only take away. Both must say yes.
 */
export function effectiveAllowActions(environmentAllows: boolean, policy: InstancePolicy | null): boolean {
  if (policy === null) return environmentAllows;
  return environmentAllows && policy.allowActions;
}

/** Looks up the human role that owns an action class, or null when it is automatic or ungoverned. */
export function requiredRoleFor(policy: InstancePolicy | null, actionClass: string): string | null {
  if (policy === null) return null;
  const gate = policy.gates.find((candidate) => candidate.actionClass === actionClass);
  return gate === undefined ? null : gate.requiresRole;
}
