/**
 * Governance contract for `scripts/ci/affected-target-policy.json` (ADR-0017).
 *
 * A quarantine entry is debt with a name on it. Every value under
 * `targets.<target>.knownUnstableProjects` must be an object carrying:
 *
 *   owner      — the GitHub handle accountable for paying the debt down
 *   expiry     — YYYY-MM-DD; on or after this date the entry FAILS the run
 *   findingId  — a registry finding (docs/reviews/_registry/findings.jsonl)
 *                or an orphan finding (docs/reviews/orphan-findings.md) that
 *                is still open; a RESOLVED finding means the debt is claimed
 *                paid and the quarantine must go
 *   reason     — free text, at least 30 characters
 *
 * The consumer of the file (write-affected-target-report.mjs) is the gate:
 * a malformed, expired, unknown-finding or resolved-finding entry exits 1
 * before any Nx target is selected, so the quarantine cannot be extended by
 * editing prose. tests/invariants/ci-quarantine-schema.spec.ts is the
 * backstop for PRs whose affected set omits the quarantined project.
 *
 * Precedent: scripts/ci/check-auth-db-ownership.mjs (exemptions require
 * owner/reason and stale exemptions fail) and validate-secrets-manifest.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const QUARANTINE_ENTRY_KEYS = Object.freeze(['owner', 'expiry', 'findingId', 'reason']);
export const MIN_REASON_LENGTH = 30;

const FINDING_ID_RE = /^[A-Z][A-Z0-9]+-(?:CRITICAL|HIGH|MEDIUM|LOW|CVE)-\d{3}[a-z]?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ORPHAN_HEADING_RE = /^##\s+(ORPHAN-(?:[A-Z]+-)?\d{3}[a-z]?)\b/;

export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function isCalendarDate(value) {
  if (!ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && isoDate(parsed) === value;
}

/**
 * Reads every finding id the repository knows and its lifecycle state.
 * Orphan findings live in markdown headings and have no state machine; they
 * are reported as OPEN so a quarantine may cite them.
 */
export function loadFindingStates(repoRoot) {
  const states = new Map();
  const registryPath = join(repoRoot, 'docs/reviews/_registry/findings.jsonl');
  if (existsSync(registryPath)) {
    for (const line of readFileSync(registryPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (typeof entry.id === 'string') states.set(entry.id, String(entry.state ?? 'OPEN'));
    }
  }
  const orphanPath = join(repoRoot, 'docs/reviews/orphan-findings.md');
  if (existsSync(orphanPath)) {
    for (const line of readFileSync(orphanPath, 'utf8').split(/\r?\n/)) {
      const match = ORPHAN_HEADING_RE.exec(line);
      if (match && !states.has(match[1])) states.set(match[1], 'OPEN');
    }
  }
  return states;
}

/**
 * Validates the whole policy document, not only the affected slice, so one
 * malformed entry anywhere fails every run that reads the file.
 *
 * @returns {string[]} human-readable violations; empty when the policy is sound.
 */
export function validateAffectedTargetPolicy(policy, { today, findingStates }) {
  const violations = [];
  const targets = policy?.targets;
  if (!targets || typeof targets !== 'object') {
    return ['policy.targets must be an object'];
  }
  if (
    !Array.isArray(policy.metadataExcludes) ||
    policy.metadataExcludes.some((x) => typeof x !== 'string')
  ) {
    violations.push('policy.metadataExcludes must be an array of strings');
  }
  for (const [target, config] of Object.entries(targets)) {
    const entries = config?.knownUnstableProjects;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      violations.push(`targets.${target}.knownUnstableProjects must be an object`);
      continue;
    }
    for (const [project, entry] of Object.entries(entries)) {
      const where = `targets.${target}.knownUnstableProjects["${project}"]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        violations.push(
          `${where}: must be an object {${QUARANTINE_ENTRY_KEYS.join(', ')}}, got ${JSON.stringify(entry)}`,
        );
        continue;
      }
      const missing = QUARANTINE_ENTRY_KEYS.filter(
        (key) => typeof entry[key] !== 'string' || entry[key].trim().length === 0,
      );
      if (missing.length > 0) {
        violations.push(`${where}: missing ${missing.join(', ')}`);
        continue;
      }
      const unknownKeys = Object.keys(entry).filter((key) => !QUARANTINE_ENTRY_KEYS.includes(key));
      if (unknownKeys.length > 0) {
        violations.push(`${where}: unknown key(s) ${unknownKeys.join(', ')}`);
      }
      if (!isCalendarDate(entry.expiry)) {
        violations.push(`${where}: expiry "${entry.expiry}" is not a YYYY-MM-DD calendar date`);
      } else if (entry.expiry <= today) {
        violations.push(
          `${where}: quarantine expired on ${entry.expiry} (today ${today}); renew it with a new expiry and justification, or remove it`,
        );
      }
      if (!FINDING_ID_RE.test(entry.findingId)) {
        violations.push(`${where}: findingId "${entry.findingId}" is not a finding id`);
      } else if (!findingStates.has(entry.findingId)) {
        violations.push(
          `${where}: findingId ${entry.findingId} is not registered in the finding registry or orphan-findings.md`,
        );
      } else if (findingStates.get(entry.findingId) === 'RESOLVED') {
        violations.push(
          `${where}: findingId ${entry.findingId} is RESOLVED — the debt is claimed paid, so the quarantine must be removed`,
        );
      }
      if (entry.reason.trim().length < MIN_REASON_LENGTH) {
        violations.push(`${where}: reason must be at least ${MIN_REASON_LENGTH} characters`);
      }
    }
  }
  return violations;
}
