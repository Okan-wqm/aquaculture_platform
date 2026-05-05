# Consent Version Bump Runbook

**Closes:** [COMPLIANCE-LOW-001](../reviews/compliance-expert/2026-04-28-core-platform-review.md#COMPLIANCE-LOW-001)

## Purpose

GDPR Article 7 requires that consent be:

1. **Informed** — the data subject understood what they consented to.
2. **Specific** — granular per processing purpose.
3. **Demonstrable** — the controller can show WHEN, WHO, WHICH VERSION.

Recording the version of the privacy policy alongside each consent
record is the audit-trail evidence that requirement (3) is met.
Bumping the version when the policy text changes is what makes
requirement (1) durable.

This runbook documents the **when** and **how** of bumping the
consent version. The **what** (the policy text itself) is owned
by Legal; this runbook covers the engineering / operations side.

---

## SemVer mapping

The consent version uses semantic versioning so engineers, legal,
and operators agree on what each segment means:

| Segment | When to bump | Trigger examples |
|---|---|---|
| **MAJOR** (`v2.0.0 → v3.0.0`) | New processing purpose added; existing consent grants are no longer covering the full policy. **Re-prompt every user**. | Adding biometric data processing; introducing AI-based profiling; adding a new recipient class (e.g. third-party AI provider). |
| **MINOR** (`v2.0.0 → v2.1.0`) | Material clarification of an existing purpose; data-retention period extended; new sub-processor of an EXISTING category. **Re-prompt at next session**. | Storage region change (EU → US); retention extended from 12 months to 24; new sub-processor for SMS delivery. |
| **PATCH** (`v2.0.0 → v2.0.1`) | Wording / typography / non-substantive clarification. **No re-prompt required**. | Fixed grammar in the policy preamble; replaced internal product name with the public one; clarified contact email format. |

Heuristic for borderline cases: **if a reasonable user would have answered differently had they seen the new wording, it's at minimum MINOR**. When in doubt, escalate to Legal.

---

## Where the version lives in code

The `currentVersion` constant is duplicated in two services because
of historical layering — both must be updated atomically in the
same commit:

| File | Line | Owner |
|---|---|---|
| `libs/backend-common/src/security/gdpr/consent-manager.service.ts` | `currentVersion` | platform-kernel |
| `apps/auth-service/src/modules/gdpr/services/user-consent.service.ts` | `currentVersion` | auth-security-expert |

Future architectural cure (tracked under COMPLIANCE-LOW-001
follow-on): unify both into a single `ConsentVersionRegistry`
service in `libs/backend-common/src/security/gdpr/` so a one-line
bump replaces a two-file edit.

---

## Bump procedure

### 1. Get Legal's signed-off policy text

Legal delivers the new policy text + the segment level
(MAJOR/MINOR/PATCH). The deliverable is a markdown file (or PDF
when ratified) that goes into a Legal-owned repository.

### 2. Open the engineering PR

Branch name: `chore/consent-version-bump-vX.Y.Z`.

In the PR:

1. Bump `currentVersion` in BOTH files listed above to the new
   version string.
2. Add a row to the consent-version changelog at
   `docs/compliance/consent-versions.md` (one row per bump,
   newest first).
3. For MAJOR / MINOR bumps, register the re-prompt cron via the
   `getUsersWithOutdatedConsent()` helper in
   `consent-manager.service.ts:216` — see "Re-prompt scheduling"
   below.
4. Cite the Legal-side PR / ticket in the commit body.

The PR must carry an explicit `Closes:` trailer pointing to the
COMPLIANCE-LOW-001 follow-on tracking the specific bump (a fresh
finding ID per bump cycle keeps the registry's per-bump audit
trail visible).

### 3. Re-prompt scheduling

For MAJOR / MINOR bumps, the platform must re-prompt users at
their next session OR on the schedule Legal specifies (some
policies require active acknowledgement within N days; others
allow rolling re-prompt at next login).

The helper `consent-manager.service.ts:getUsersWithOutdatedConsent()`
returns the set of users whose stored consent version is below
`currentVersion`. Wire it via:

  - **At-next-session re-prompt** (default for MINOR): the auth
    middleware checks `getUsersWithOutdatedConsent()` membership
    on session refresh and emits a `consent.outdated` event the
    frontend renders as a modal.
  - **Hard-deadline re-prompt** (default for MAJOR): a daily cron
    in `auth-service` enumerates outdated users and sends an
    email; users who don't re-consent within the policy-specified
    grace period have their tenant flagged for processing
    suspension per Legal's policy.

The current platform has the helper but no scheduled wiring —
that wiring is the engineering follow-on, tracked separately per
bump.

### 4. Stale-consent erasure trigger

If the policy bump introduces a new processing purpose, users who
DON'T re-consent fall under the GDPR "withdrawal" treatment for
the new purpose — meaning the platform must NOT process their
data under the new purpose until they affirmatively consent.
This is enforced by:

  - The middleware filter: any controller path that processes
    data under the new purpose checks
    `consentManager.hasConsentFor(userId, purpose, currentVersion)`.
  - Existing data acquired under the old version may continue
    being processed under the OLD purpose grant, but cross-version
    data flow is forbidden until re-consent.

This is the engineering implementation of GDPR's principle that
consent is purpose-specific, not blanket-grant.

### 5. Audit-row evidence

Every consent-related action (grant, withdraw, version-bump,
re-prompt) emits a row to `shared.audit_logs` with
`action='CONSENT_<verb>'` and the version in metadata. The
audit-trail-completeness-auditor invariant (see
`docs/reviews/audit-trail-completeness-auditor/2026-04-28-core-platform-review.md`)
asserts coverage; the per-bump runbook only needs to verify the
new actions emit correctly via the existing test suite.

---

## Why we don't auto-bump on every minor wording change

A version bump triggers (depending on segment) re-prompts that
disrupt every user. Bumping for cosmetic changes (typo fixes,
brand renames) would train users to dismiss the consent modal
without reading — defeating the GDPR "informed" requirement. The
PATCH segment exists specifically so cosmetic changes can update
the displayed text WITHOUT triggering a re-prompt.

The flip side: a substantive change shipped as PATCH is a
compliance violation. The decision tree:

  - "Would a reasonable user have answered differently?" → MINOR or MAJOR.
  - "Is the wording change substantive enough that a reviewer
    couldn't argue both versions mean the same thing?" → MINOR.
  - "Is the change a typo, brand rename, or non-substantive
    clarification?" → PATCH.

When unsure, escalate to Legal. The cost of a needlessly-bumped
MINOR is one user interruption; the cost of a wrongly-classified
PATCH is a regulatory finding.

---

## Future architectural cures (tracked, not done)

| Item | Tier | Tracked under |
|---|---|---|
| Unified `ConsentVersionRegistry` service replacing the two-constant duplication | Tier-1 | COMPLIANCE-LOW-001 follow-on |
| Inline privacy-policy text on `ConsentSettingsPage` (currently shows label/description only) | Tier-2 | COMPLIANCE-LOW-002 |
| Scheduled re-prompt cron wired to `getUsersWithOutdatedConsent()` | Tier-2 | COMPLIANCE-LOW-001 follow-on |

---

## Related documents

- ADR-008 — Guard strategy (authorization gates that consume consent state)
- `docs/security/` — full GDPR compliance audit reports
- `apps/auth-service/src/modules/gdpr/` — consent-related services and entities
