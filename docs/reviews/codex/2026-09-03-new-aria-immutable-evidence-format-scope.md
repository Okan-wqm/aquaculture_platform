# New ARIA immutable evidence format-scope review

Date: 2026-09-03

Reviewer: Codex integrity role 01

Scope: repository formatter ownership for the new ARIA plan only

## PROC-HIGH-018 — formatter owned hash-pinned historical evidence

Status: RESOLVED by the commit that carries this finding's `Closes:` footer.

The format-scope classifier treated every file under `docs/` as live canonical documentation.
That included the new ARIA review snapshots and machine evidence whose exact bytes are referenced
by signed manifests and append-only event records. A later formatting pass could therefore rewrite
already-published evidence while leaving its historical introduction commit unchanged.

The classifier now gives only these two new-ARIA subtrees immutable ownership:

- `docs/plans/2026-09-01-new-aria-autonomous-engineering/reviews/`
- `docs/plans/2026-09-01-new-aria-autonomous-engineering/progress/evidence/`

Live plan documents remain formatter-managed. A temporary-repository regression test executes the
real generator and proves both immutable classifications and the live-plan control case. No legacy
ARIA path or runtime behavior is changed.

### Verification

- Red: both evidence paths were emitted as `canonical_docs` with `prettier_managed: true`.
- Green: `format-scope-derived-scalars.spec.ts` passes with the production classifier.

## PROC-HIGH-019 — nested Git fixture inherited its caller's index

Status: RESOLVED by the commit that carries this finding's `Closes:` footer.

The first regression fixture created a temporary repository but passed the complete commit-hook
environment into its child Git processes. Git supplies `GIT_INDEX_FILE` to hooks, so `git add` in
the nested fixture replaced the caller's staging index instead of the temporary repository's
index. The working tree remained intact. The damaged index was backed up, rebuilt from `HEAD`, and
only the five intended paths were restaged.

The fixture now removes every ambient `GIT_*` variable for both Git and the copied generator. It
also injects a poison index path and asserts that no child process creates it, so the test exercises
the isolation guarantee without risking its caller's real index.
