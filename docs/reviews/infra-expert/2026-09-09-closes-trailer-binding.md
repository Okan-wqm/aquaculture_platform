# The Closes: trailer gate admits trailers that can never close — infra-expert, 2026-09-09

Found while answering "what is actually left in the platform", which required trusting the
finding registry. The registry was wrong, and the gate that is supposed to keep it right had
two holes.

## PROC-HIGH-031 — admission is looser than derivation, so a trailer can pass CI and still close nothing

A `Closes:` trailer carries two halves — a review-file path and a finding id — and two different
matchers read them:

| Matcher                                                                        | Used by                                                | Binds                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------ |
| `commitMessageClosesFindingExactly` (`tools/gates/finding-traceability.ts:87`) | `close`, `reconcile`, `finding-registry-closure-drift` | id **and**, when anchored, the finding's `review_file` |
| `tools/gates/commit-msg-validator.ts` registry lane (`:588`)                   | the `validate-closes` CI gate                          | id only — the path is merely checked to exist on disk  |

`finding-registry.ts:1498-1503` already documents the asymmetry in prose ("Derivation is stricter
than admission … it would let a reused id be closed by a commit that cited another review file")
but only the derivation side was ever hardened. So a commit could pass the gate carrying a
trailer `reconcile` would never honour, and nothing said so at any point.

A second, independent hole sat above it: `validateCommit` returned early for any commit whose
type does not REQUIRE a trailer. Requiring a trailer and validating one are different questions.
A `refactor(<scope>)`, `test(…)` or `chore(…)` commit that carried a trailer anyway had it
accepted completely unread.

### It is not hypothetical

PR #1425's two auth commits shipped to main citing a finding that was renumbered out from under
them by the #1420 registry ceremony:

```
793dbfd34 refactor(auth-service): resolve every emailed link segment through ActionTokenResolver
77d164947 fix(auth-service): mint an ActionToken row for every invitation delivery
    Closes: docs/reviews/orchestrator/2026-09-05-production-readiness-gaps.md#SEC-HIGH-056
```

The path is this programme's review document; the id belongs to an unrelated, already-RESOLVED
admin-api SQL-injection finding whose review file is
`docs/reviews/security/2026-08-23-vuln-scan-findings.md`. The two halves contradict each other.

`793dbfd34` was skipped by the type check; `77d164947` was validated and passed. Both merged.

**Consequence:** `SEC-HIGH-158` (invitation e-mail links cannot be validated) and `SEC-HIGH-159`
(super-admin password recovery silently does nothing) are OPEN with `closing_commits: []`,
although their fixes are on main — `action-token-resolver.service.ts`, `config/frontend-url.ts`
and `libs/event-contracts/src/tenant-scope.ts` are all present. The ledger reports two security
defects as unfixed that are fixed, which is how "what is left" became unanswerable.

### Why an alias is not the remedy

`finding-id-aliases.yaml` maps a historical id onto the canonical row that tracks the same
finding. Here the cited id is a _different, real_ finding, so aliasing `SEC-HIGH-056` to
`SEC-HIGH-158` would corrupt an unrelated closed row. The trailers cannot be amended either —
they are merged history and force-push is banned. Closure has to rest on new evidence.

### Fix

One matcher, both callers: the gate asks the derivation's own
`commitMessageClosesFindingExactly` whether the trailer it is admitting could ever close the
finding it names, and refuses it when it could not. The two can no longer drift apart, because
there is only one of them. Validation is also separated from requirement, so every trailer that
is present is read, whatever the commit type.

The deliberate looseness stays: a bare, un-anchored `Closes: <ID>` asserts no document and is
still admitted, because the derivation honours it. Only a contradiction between the two halves
of an anchored trailer is refused.

The ARIA lane of the same validator has cross-checked path against id since Plan 018 Phase 4;
this is that rule reaching the registry lane.
