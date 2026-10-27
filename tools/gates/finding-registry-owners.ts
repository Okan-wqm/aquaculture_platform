/**
 * finding-registry-owners — the one identity rule for a finding's `owner_user` (ARIA-MEDIUM-535).
 *
 * WHY. `owner_user` is the GitHub handle accountable for closing a finding
 * (findings.jsonl.schema.json), and a BLOCKED override must be signed by that
 * owner per `.github/CODEOWNERS` (registry README, commit trailer rule 4). The
 * add path stored the value as given, so one person appeared as `okan`,
 * `@okan-wqm`, `Okan-Wqm` and an email, and agent role names appeared beside
 * them: nothing could compare an owner with a CODEOWNERS handle.
 *
 * THE RULE. The identities are the `@handle` owners of `.github/CODEOWNERS`
 * (GitHub logins; team handles `@org/team` included). `canonicalOwner` maps a
 * value to the CODEOWNERS spelling of the handle without the `@`: GitHub logins
 * are case-insensitive, so `@okan-wqm` and `Okan-Wqm` both resolve to
 * `Okan-wqm`. Anything else (a bare first name, an email, a role) is refused:
 * deciding which person it means is an identity decision, made explicitly with
 * `finding-registry canonicalize-owner <spelling> --to=<handle> --reason=<why>`.
 *
 * WHERE IT APPLIES. `add` and `assign` store the canonical handle;
 * `ownerViolations` is part of the event sink (finding-registry-events.ts
 * `appendFindingEvents`), so any event that sets an owner (a new finding, or an
 * assignment or amendment of its owner) must set a canonical one. A row whose
 * legacy owner an event merely carries (a sweep) is left to the integrity
 * invariant, which allows only LEGACY_OWNER_SPELLINGS beside the handles.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { type Finding } from './finding-registry-chain';

export const CODEOWNERS_PATH = resolve(__dirname, '..', '..', '.github', 'CODEOWNERS');

/**
 * Owner spellings registered before this rule that name no CODEOWNERS handle
 * and whose identity needs the operator's decision (an email, two role names).
 * Shrink-only: the integrity invariant fails when an entry no longer occurs, so
 * a `canonicalize-owner` run removes it here in the same change.
 */
export const LEGACY_OWNER_SPELLINGS: readonly string[] = [
  'by-okan@live.com',
  'claude-session',
  'farm-module maintainer',
];

const HANDLE = /^@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9._-]+)?)$/;

/** The `@handle` owners of a CODEOWNERS file, in their CODEOWNERS spelling without the `@`. */
export function codeownersHandles(text: string): string[] {
  const handles = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    // The first token is the path pattern; the rest are owners.
    for (const token of line.split(/\s+/).slice(1)) {
      const match = HANDLE.exec(token);
      const handle = match?.[1];
      if (handle !== undefined && !handles.has(handle.toLowerCase())) {
        handles.set(handle.toLowerCase(), handle);
      }
    }
  }
  return [...handles.values()].sort();
}

let cachedHandles: readonly string[] | null = null;
/** The live CODEOWNERS handles of this checkout. */
export function loadCodeownersHandles(): readonly string[] {
  cachedHandles ??= codeownersHandles(readFileSync(CODEOWNERS_PATH, 'utf8'));
  return cachedHandles;
}

export type OwnerResolution =
  | { readonly ok: true; readonly owner: string }
  | { readonly ok: false; readonly reason: string };

/** The CODEOWNERS handle `value` names (case-insensitive, `@` optional), or a refusal. */
export function canonicalOwner(
  value: string,
  handles: readonly string[] = loadCodeownersHandles(),
): OwnerResolution {
  const login = value.trim().replace(/^@/, '');
  const handle = handles.find((candidate) => candidate.toLowerCase() === login.toLowerCase());
  if (login !== '' && handle !== undefined) return { ok: true, owner: handle };
  return {
    ok: false,
    reason:
      `owner_user ${JSON.stringify(value)} is not a .github/CODEOWNERS handle ` +
      `(${handles.map((h) => `@${h}`).join(', ')}); write the handle, or map a legacy spelling ` +
      'with: finding-registry canonicalize-owner <spelling> --to=<handle> --reason=<why>',
  };
}

/**
 * Sink rule: every owner a write sets (a new row, or a row whose `owner_user`
 * this write changes) is null or a canonical handle.
 */
export function ownerViolations(
  previous: readonly Finding[],
  changed: readonly Finding[],
  handles: readonly string[] = loadCodeownersHandles(),
): string[] {
  const before = new Map(previous.map((entry) => [entry.id, entry.owner_user]));
  const violations: string[] = [];
  for (const row of changed) {
    const owner = row.owner_user;
    if (owner === null || (before.has(row.id) && before.get(row.id) === owner)) continue;
    const resolved = canonicalOwner(owner, handles);
    if (!resolved.ok) violations.push(`${row.id} /owner_user: ${resolved.reason}`);
    else if (resolved.owner !== owner) {
      violations.push(
        `${row.id} /owner_user: ${JSON.stringify(owner)} must be written as ${JSON.stringify(resolved.owner)}`,
      );
    }
  }
  return violations;
}

export interface OwnerCanonicalizationRequest {
  /** The exact stored spelling to rewrite. */
  readonly spelling: string;
  /** The handle it means; omitted when the spelling resolves by itself (a case or `@` variant). */
  readonly to?: string;
  readonly reason: string;
  readonly now: Date;
}

export type OwnerCanonicalizationOutcome =
  | { readonly ok: true; readonly owner: string; readonly indexes: readonly number[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Rewrites every row whose `owner_user` is exactly `spelling` to the canonical
 * handle, recording the change and its reason in `notes`; refuses without
 * touching anything when the target is not a handle or no reason is given. The
 * caller records each changed row as an AMENDED event.
 */
export function applyOwnerCanonicalization(
  entries: Finding[],
  request: OwnerCanonicalizationRequest,
  handles: readonly string[] = loadCodeownersHandles(),
): OwnerCanonicalizationOutcome {
  const reason = request.reason.trim();
  if (reason === '') {
    return { ok: false, reason: 'canonicalize-owner requires --reason=<why this identity>' };
  }
  if (request.spelling.trim() === '') {
    return { ok: false, reason: 'canonicalize-owner requires the stored spelling to rewrite' };
  }
  const target = canonicalOwner(request.to ?? request.spelling, handles);
  if (!target.ok) return target;
  const stamp = request.now.toISOString().slice(0, 10);
  const indexes: number[] = [];
  entries.forEach((entry, index) => {
    if (entry.owner_user !== request.spelling || entry.owner_user === target.owner) return;
    entry.owner_user = target.owner;
    entry.notes =
      String(entry.notes ?? '') +
      ` [canonicalize-owner ${stamp}: owner_user ${request.spelling} -> ${target.owner} — ${reason}]`;
    indexes.push(index);
  });
  return { ok: true, owner: target.owner, indexes };
}
