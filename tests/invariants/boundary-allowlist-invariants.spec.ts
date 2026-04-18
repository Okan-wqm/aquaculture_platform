/**
 * Boundary Allowlist Invariants
 * ============================================================================
 *
 * Closes Phase 6c of /root/.claude/plans/synthetic-dazzling-hippo.md
 * (finding CLAUDE-MEDIUM-005).
 *
 * .claude/allowlists/boundary-files.yaml is the declarative allowlist for
 * Tier-4 escape hatches (MQTT wire, Stripe webhook, jsonb event-store,
 * generated proto, zod boundary validators). Each entry carries:
 *
 *   - path      — glob
 *   - reason    — one-line rationale
 *   - owner     — GitHub handle (typically @Okan-wqm)
 *   - expires   — ISO date OR the literal `never`
 *   - notes     — free-text elaboration
 *   - rules     — ESLint rule IDs relaxed for this entry
 *
 * Two invariants gated here:
 *
 *   1. Every entry with `expires: never` carries an ADR reference in
 *      `reason` or `notes` (regex `ADR-\d{3}` or `docs/adr/\d{3}-…`).
 *      The README says `expires: never` requires an ADR; this spec is
 *      the Tier-3 gate that backs the declaration.
 *
 *   2. Every dated `expires:` is ≤ 18 months in the future from today.
 *      The README caps the window at 12 months for new entries; loose
 *      18-month ceiling catches clearly-invalid values (e.g., 2099) while
 *      tolerating the existing 2027-04 cohort from the 2026-04-17 seed.
 *
 * # References
 *
 *   - /root/.claude/plans/synthetic-dazzling-hippo.md#Phase-6c
 *   - .claude/allowlists/boundary-files.yaml
 *   - .claude/agents-enterprise-v2/_shared/tier-claim-syntax.md § "Boundary allowlist"
 */

import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ALLOWLIST = path.join(REPO_ROOT, '.claude', 'allowlists', 'boundary-files.yaml');

interface AllowlistEntry {
  readonly path: string;
  readonly reason?: string;
  readonly owner?: string;
  readonly expires?: string | Date;
  readonly notes?: string;
}

interface Allowlist {
  readonly version: number;
  readonly codeowners: string;
  readonly entries: readonly AllowlistEntry[];
}

function loadAllowlist(): Allowlist {
  const raw = fs.readFileSync(ALLOWLIST, 'utf8');
  return YAML.parse(raw) as Allowlist;
}

function hasAdrReference(text: string | undefined): boolean {
  if (!text) return false;
  return /ADR-\d{3}\b/.test(text) || /docs\/adr\/\d{3}/.test(text);
}

function toDate(value: string | Date | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (value === 'never') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

describe('boundary allowlist invariants', () => {
  const allowlist = loadAllowlist();

  it('allowlist parses + has at least one entry (otherwise this invariant is a no-op regression)', () => {
    expect(allowlist.entries).toBeDefined();
    expect(allowlist.entries.length).toBeGreaterThan(0);
  });

  it('CODEOWNERS gate declared', () => {
    expect(allowlist.codeowners).toMatch(/^@/);
  });

  describe('expires: never entries carry an ADR reference', () => {
    const neverEntries = allowlist.entries.filter((e) => e.expires === 'never');

    it('at least one "expires: never" entry exists (sanity)', () => {
      expect(neverEntries.length).toBeGreaterThan(0);
    });

    it.each(neverEntries)('entry $path has ADR reference in reason/notes', (entry) => {
      const adrInReason = hasAdrReference(entry.reason);
      const adrInNotes = hasAdrReference(entry.notes);
      if (!adrInReason && !adrInNotes) {
        throw new Error(
          `Entry path="${entry.path}" has expires: never but no ADR reference in reason/notes. ` +
            'Permanent Tier-4 relaxations must cite a specific ADR (format "ADR-NNN" or "docs/adr/NNN-...") ' +
            'per .claude/allowlists/boundary-files.yaml rule #2 + tier-claim-syntax.md § Boundary allowlist.',
        );
      }
      expect(adrInReason || adrInNotes).toBe(true);
    });
  });

  describe('dated expires: are within an 18-month horizon (loose ceiling)', () => {
    const MAX_HORIZON_MS = 18 * 30 * 24 * 60 * 60 * 1000;
    const dated = allowlist.entries
      .map((e) => ({ entry: e, date: toDate(e.expires) }))
      .filter((x): x is { entry: AllowlistEntry; date: Date } => x.date !== null);

    it('at least one dated entry exists (sanity — pure "never" allowlist would skip this invariant)', () => {
      expect(dated.length).toBeGreaterThan(0);
    });

    it.each(dated)('entry $entry.path expires by $entry.expires within 18 months', ({ entry, date }) => {
      const now = new Date();
      const horizon = new Date(now.getTime() + MAX_HORIZON_MS);
      if (date.getTime() > horizon.getTime()) {
        throw new Error(
          `Entry path="${entry.path}" expires: ${entry.expires} — more than 18 months in the future. ` +
            'Cap is 12 months per README; 18-month ceiling here flags clearly-invalid values (e.g. 2099). ' +
            'Either shorten the window or convert to expires: never with an ADR reference.',
        );
      }
      expect(date.getTime()).toBeLessThanOrEqual(horizon.getTime());
    });
  });
});
