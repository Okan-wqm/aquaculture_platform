// The instance manifest, actually applied.
//
// WHY: `arias/<id>/aria.manifest.json` declares what an instance may do —
// `runtime.allow_actions`, `runtime.profile_ceiling`, the corpus roots it must
// never read, and a pointer to an approval policy naming which human role owns
// which action class. MEASURED on 2026-09-04: nothing loaded any of it, and once
// it was loaded only the boolean was enforced — so hard that the shipped legal
// instance could not open a case, while the five lawyer gates that should have
// decided were parsed and discarded. A policy no code reads is not a policy —
// it is a document that makes a reader believe a gate exists.
//
// WHAT: loads the manifest named by ARIA_INSTANCE_MANIFEST plus the approval
// policy it points at, and exposes them to the server. Three rules govern the
// result, all deliberate:
//
//   1. `allow_actions` governs KERNEL control only (cycle run, pause, resume),
//      and may only NARROW: it can turn kernel control off when the operator's
//      environment enabled it; it can never turn it on.
//   2. Case work is decided by the policy's gates, per action class, per role
//      (`decideGate`). A class the policy does not name is refused, not allowed.
//   3. It fails CLOSED. A missing, unparseable or malformed manifest or policy,
//      a gate owned by a role the console cannot authenticate, or a legal
//      console whose policy leaves a legal action class ungoverned, stops the
//      server. Carrying on with the policy silently absent is exactly the state
//      this module was written to end.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { LEGAL_ACTION_CLASSES } from '../../shared/legal-contract.ts';
import { ConfigError } from './config.ts';
import { isPrincipalRole } from './principal.ts';

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
  /** Whether the instance file permits kernel control from the console. */
  readonly allowActions: boolean;
  /** Corpus roots the instance declares off-limits; forwarded to every adapter run. */
  readonly corpusExcludeRoots: ReadonlyArray<string>;
  /** Console feature modules the instance presents (`surface.console.modules`). */
  readonly consoleModules: ReadonlyArray<string>;
  readonly approvalPolicyPath: string | null;
  /** Role ids the policy declares; every gate's owner is one of them. */
  readonly roles: ReadonlyArray<string>;
  readonly gates: ReadonlyArray<ApprovalGate>;
}

export type GateDecision =
  | { readonly allowed: true; readonly basis: 'automatic' | 'role' }
  | { readonly allowed: false; readonly reason: 'action_class_ungoverned'; readonly requiredRole: null }
  | { readonly allowed: false; readonly reason: 'role_required'; readonly requiredRole: string };

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

function readStringArray(source: Record<string, unknown>, key: string, label: string): string[] {
  const value = source[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    fail(`${label} must be an array of non-empty strings`);
  }
  return (value as string[]).map((item) => item.trim());
}

/** Canonical archive-relative policy paths are sent unchanged to every worker. */
function corpusExclusions(corpus: Record<string, unknown> | null): string[] {
  if (corpus === null) return [];
  const roots = readStringArray(corpus, 'exclude_roots', 'corpus.exclude_roots');
  const normalized = roots.map(root => {
    const path = root.replace(/\\/g, '/');
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\0')) fail('corpus.exclude_roots must contain relative archive paths');
    const parts = path.split('/');
    if (parts.includes('..')) fail('corpus.exclude_roots cannot traverse outside the archive');
    const canonical = parts.filter(part => part !== '' && part !== '.').join('/');
    if (canonical === '') fail('corpus.exclude_roots cannot name the archive root');
    return canonical;
  });
  return [...new Set(normalized)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function parseRoles(policy: Record<string, unknown>, path: string): string[] {
  const raw = policy['roles'];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(`approval policy at ${path} roles must be an array`);
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail(`approval policy roles[${index}] must be an object`);
    const id = (entry as Record<string, unknown>)['id'];
    if (typeof id !== 'string' || id.trim() === '') fail(`approval policy roles[${index}].id must be a non-empty string`);
    return id.trim();
  });
}

function parseGates(policy: Record<string, unknown>, path: string, roles: ReadonlyArray<string>): ApprovalGate[] {
  const raw = policy['gates'];
  if (!Array.isArray(raw)) fail(`approval policy at ${path} must declare a gates array`);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(`approval policy gates[${index}] must be an object`);
    }
    const gate = entry as Record<string, unknown>;
    const actionClass = gate['action_class'];
    if (typeof actionClass !== 'string' || actionClass.trim() === '') {
      fail(`approval policy gates[${index}].action_class must be a non-empty string`);
    }
    if (seen.has(actionClass.trim())) fail(`approval policy gates[${index}] (${actionClass}) is declared twice; one class has one owner`);
    seen.add(actionClass.trim());
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
    // A gate owned by a role the policy never declared, or one the console has
    // no way to authenticate, is a gate nobody can ever pass. Saying so at
    // startup beats a lawyer discovering it as a permanent 403.
    if (requiresRole !== null && roles.length > 0 && !roles.includes(requiresRole)) {
      fail(`approval policy gates[${index}] (${actionClass}) requires role ${requiresRole}, which the policy's roles do not declare`);
    }
    if (requiresRole !== null && !isPrincipalRole(requiresRole)) {
      fail(`approval policy gates[${index}] (${actionClass}) requires role ${requiresRole}, which this console cannot authenticate`);
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

  const corpus = readObject(manifest, 'corpus');
  const corpusExcludeRoots = corpusExclusions(corpus);

  const surface = readObject(manifest, 'surface');
  const console = surface === null ? null : readObject(surface, 'console');
  const consoleModules = console === null ? [] : readStringArray(console, 'modules', 'surface.console.modules');

  const policies = readObject(manifest, 'policies');
  let approvalPolicyPath: string | null = null;
  let roles: string[] = [];
  let gates: ApprovalGate[] = [];
  if (policies !== null) {
    const approval = policies['approval'];
    if (approval !== undefined && approval !== null) {
      if (typeof approval !== 'string' || approval.trim() === '') fail('policies.approval must be a non-empty path');
      // The pointer is relative to the manifest, so an instance directory stays
      // movable as a unit.
      approvalPolicyPath = resolve(dirname(manifestPath), approval.trim());
      const policy = readJson(approvalPolicyPath, 'approval policy');
      roles = parseRoles(policy, approvalPolicyPath);
      gates = parseGates(policy, approvalPolicyPath, roles);
    }
  }

  // A legal console with a class no gate governs would refuse that class
  // forever (rule 2). That is a policy defect, and it is refused here where the
  // operator can read it, not on a lawyer's screen as a 403.
  if (consoleModules.includes('legal')) {
    const governed = new Set(gates.map((gate) => gate.actionClass));
    const ungoverned = LEGAL_ACTION_CLASSES.filter((actionClass) => !governed.has(actionClass));
    if (ungoverned.length > 0) {
      fail(`the legal console needs every legal action class governed; ${approvalPolicyPath ?? 'the approval policy'} leaves ${ungoverned.join(', ')} unnamed`);
    }
  }

  return Object.freeze({
    manifestPath,
    instanceId,
    displayName,
    profileCeiling,
    allowActions,
    corpusExcludeRoots: Object.freeze(corpusExcludeRoots),
    consoleModules: Object.freeze(consoleModules),
    approvalPolicyPath,
    roles: Object.freeze(roles),
    gates: Object.freeze(gates),
  });
}

/**
 * The effective KERNEL-CONTROL permission. The environment grants; the instance
 * file may only take away. Both must say yes.
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

/**
 * Whether a principal holding `role` may perform `actionClass` under the policy.
 *
 * An automatic class is open to any authenticated principal; a role-owned class
 * only to that role; a class the policy never names is refused. The last rule
 * is the one that makes the policy an authority: silence is not consent.
 */
export function decideGate(policy: InstancePolicy, role: string, actionClass: string): GateDecision {
  const gate = policy.gates.find((candidate) => candidate.actionClass === actionClass);
  if (gate === undefined) return { allowed: false, reason: 'action_class_ungoverned', requiredRole: null };
  if (gate.auto || gate.requiresRole === null) return { allowed: true, basis: 'automatic' };
  if (gate.requiresRole === role) return { allowed: true, basis: 'role' };
  return { allowed: false, reason: 'role_required', requiredRole: gate.requiresRole };
}
