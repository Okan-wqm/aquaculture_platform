# Consent Version Changelog

**Closes:** [COMPLIANCE-LOW-001](../reviews/compliance-expert/2026-04-28-core-platform-review.md#COMPLIANCE-LOW-001)

Newest first. One row per bump cycle. The full bump procedure is at
[`docs/runbooks/consent-version-bump.md`](../runbooks/consent-version-bump.md).

| Version | Effective date | Segment | Re-prompt policy | Triggering change | Legal ref | Engineering PR |
|---|---|---|---|---|---|---|
| `2.0.0` | 2026-01-01 | — | _(initial release of the v2 series; not a bump from v1)_ | — | — | — |

## Future entries (template)

```
| `X.Y.Z` | YYYY-MM-DD | MAJOR/MINOR/PATCH | at-next-session / hard-deadline / none | one-line summary | Legal-PR-link | Eng-PR-link |
```

## Why this file is checked in

The consent version is application code (it lives at
`consent-manager.service.ts:currentVersion`). A version bump
without a corresponding row here is a process gap: the runbook's
step 2 instructs every PR author to add a row at bump time, and
the per-bump invariant tests that follow will assert the
changelog row exists for the new version.

## Schema notes

- **Effective date** = the deploy date of the engineering PR that
  bumped the constant. NOT the date Legal approved the policy
  (which can be earlier). The effective date marks when audit
  rows started carrying the new version.
- **Re-prompt policy** = which strategy the engineering PR wired
  for users with the outdated version (see the runbook).
- **Triggering change** = one-line summary that's enough for a
  future maintainer to reconstruct the WHY without reading the
  Legal PR. If the triggering change is sensitive, link to the
  internal-only ticket and put just "see internal ticket" here.
