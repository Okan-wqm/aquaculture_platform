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

```text
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

## PROC-MEDIUM-032 — a fix can be merged against a finding and still be unrecordable

PROC-HIGH-031 stops the next mis-bound trailer. It does not repair the ones already
merged, and measuring those turned up a second, independent defect.

Every `Closes:` trailer on `origin/main` was matched against the OPEN/IN-PROGRESS rows:
**23 active findings are named by a merged trailer.** Three bind correctly and the ledger
is right about them — `INFRA-HIGH-147` and `PLAT-MEDIUM-901` carry `rejected_closing_commits`
(deliberate reopens), and `INFRA-MEDIUM-168` has an empty `review_file`. The other **20 do
not bind**, in two distinct sub-classes.

|       | path          | id                                        | example            |
| ----- | ------------- | ----------------------------------------- | ------------------ |
| **A** | right         | **wrong** — a ceremony renumbered the row | `SEC-HIGH-158/159` |
| **B** | **different** | right                                     | the other 20       |

Sub-class B is usually not staleness. It is two legitimate documents:
`SENSOR-HIGH-105` was **raised** in `docs/reviews/zcode/2026-09-03-100-tenant-readiness-integration.md:52`
and **closed** by `1f94881db` citing `docs/reviews/zcode/2026-09-04-telemetry-readiness-v4-port.md:92`.
Both files exist and both carry a heading for the id. A finding is raised in one review cycle
and fixed in another; the ledger's `review_file` records the raise, the trailer records the
fix, and the exact matcher demands they be the same string.

An id in this position has `finding-id-aliases.yaml`. A path has no equivalent, so `close`
and `reconcile` refuse the real closer permanently and the finding stays OPEN forever.

**Tested and disproved:** the hypothesis that an append-only chain retains the prior
`review_file`, which would allow a mechanical repair. Each id has exactly one row. There is
no shortcut; each of the 20 has to be verified against code.

**Fix direction (tier 1, one mechanism rather than a second one):** extend the SAME sidecar
with declared closure anchors, folded into `FindingTrailerTarget` by `withFindingAliases` and
matched only in the anchored branch. The backward-looking derivation loads them; the
forward-looking commit-msg gate does not, so a NEW commit must still cite the current
`review_file` and PROC-HIGH-031 is not quietly reopened. Guarded by the mirror of the
invariants the alias sidecar already carries: the declared path exists, carries a heading for
that id, and at least one named merged commit really cites it.

Not attempted in this branch (owner @okan-wqm, 2026-10-31). It is the blocking dependency for
closing `SENSOR-HIGH-105`, and closing 20 ledger rows is bookkeeping — it does not outrank the
sensor work queued behind it.

## The pilot-scope four, verified against code

The four in-scope findings named by a merged trailer, each read against the source rather than
against the report that raised it.

| Finding           | Code says                                                                                                                                                                | Ledger is                   | Action                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FARM-HIGH-151`   | **fixed** — all ten handlers resolve currency through `FinanceSettingsService`; `finance-currency-ssot.spec.ts` green                                                    | OPEN, `closing_commits: []` | closed in this branch, with the guard turned from a named list into a rule                                                                                                                                                                                                                           |
| `SENSOR-HIGH-097` | **fixed** — `compliance/erasure/` hooks, `MqttAuthService.invalidateEntriesForTenant`, `ErasedTenantTombstoneService`; closer `65753cb90` is on main                     | OPEN                        | **cannot close.** Its trailer cites `2026-08-24-100-tenant-readiness.md`, which has never carried a `SENSOR-HIGH-097` heading — the 2026-09-03 integration review records exactly that at `:162`. Even PROC-MEDIUM-032's mechanism would not admit it, because the declared anchor must really exist |
| `SENSOR-HIGH-105` | **fixed** — `@dsnp/parquetjs` is a declared dependency, `ARCHIVE_CODEC_ID_V2 = 'parquet'`, the exporter writes `aqua-telemetry-archive/2`; closer `1f94881db` is on main | OPEN                        | **cannot close** — textbook sub-class B; blocked on PROC-MEDIUM-032                                                                                                                                                                                                                                  |
| `MSG-HIGH-078`    | **not fixed**                                                                                                                                                            | OPEN                        | correct, left alone                                                                                                                                                                                                                                                                                  |

`MSG-HIGH-078` deserves its measurement, because its shape changed. The finding described drift
between a committed lock at `sanitize-html` 2.17.5 and a mutable `node_modules` at 2.17.6, and
prescribed pinning 2.17.5 exactly. Today `package.json` asks for `^2.17.7` and the lock resolves
2.17.7 — so the range was widened, not pinned, and the violation is now committed rather than
drifted. The two halves have separated:

- **Jest breakage: gone.** `edit-message.handler.spec.ts` (which imports `shared/sanitize`
  unmocked) passes 7/7, and there is no `transformIgnorePatterns` escape in
  `apps/messaging-service/jest.config.ts`. CI runs Node 22, where `require()` of the nested
  ESM-only `htmlparser2@12` works.
- **Node floor violation: live and now committed.** `engines.node` is `>=20.11.0` and `.nvmrc`
  is `20.11.0`, while the installed `sanitize-html@2.17.7` declares `engines.node >=22.12.0`.

`FARM-CRITICAL-238` / `FARM-HIGH-239` are IN-PROGRESS in a parallel session's area and were not
touched. The EDGE/BILLING/LEGAL/ORPHAN/ARIA members of the 20 are outside the pilot; they are
recorded here and not chased.

## What the FARM-HIGH-151 verification found on its own

`finance-currency-ssot.spec.ts` guards `FINANCE_HANDLER_ROOTS` recursively **plus a hardcoded
`NAMED_GUARDED_FILES` list** — which is the ratchet FARM-HIGH-151's own notes describe ("migrate
a handler, add it to the guarded set"). A handler outside those roots that nobody remembers to
list is not guarded, and running the spec's own `CURRENCY_FALLBACK` pattern over every
`apps/**/*.handler.ts` found **7 unguarded writers**:

- `create-payroll.handler.ts:108,197` and `approve-payroll.handler.ts:72` — **HR-HIGH-008**.
  A real defect: the same service already resolves the tenant default through
  `PayrollCostSettingsService.getDefaultCurrencyInTx` (`create-employee.handler.ts:67`), and
  `approve-payroll` stamps `savedPayroll.currency || 'USD'` onto the cross-service
  `PayrollProcessed` event.
- five billing handlers — **BILLING-MEDIUM-016**. Not asserted to be a defect: platform billing
  in USD is a defensible policy. The defect is that nothing in the code declares which reading is
  intended, so no gate can enforce either.

**SEC-LOW-168** records the one genuine test gap found while closing SEC-HIGH-159.

## FARM-HIGH-151 closed by making its own ratchet a rule

The finding is fixed in code — all ten handlers resolve the tenant currency
through `FinanceSettingsService` / `PayrollCostSettingsService`. It had no closing
commit at all: the `FARM-HIGH-151` trailers on main belong to the _regulatory_
finding that used to hold that sequence before `a909ceae5` renumbered it, so they
name a different finding entirely. Not sub-class A or B — a third shape, and the
reason a verify-and-close pass has to read the trailer's subject, not just its id.

Closing it on a documentation commit would have been ceremony, so the closing
change is the one the finding's own notes asked for. Its ratchet was
`NAMED_GUARDED_FILES`, a hardcoded array: "migrate a handler, add it to the
guarded set". A ratchet whose coverage is a memo is not a ratchet, and the
docblock's claim that "there is no longer a hardcoded-currency create-handler
outside this guarded set" was simply false — running the spec's own pattern over
every `apps/**/*.handler.ts` found **7 unguarded writers**, one of them a live
defect (HR-HIGH-008).

The guard now scans every `*.handler.ts` **and** every `*.entity.ts` under
`apps/`, and a currency literal fails unless it is a declared exemption citing an
open ledger finding. The list can only shrink: a declared entry whose literal is
gone fails as stale, and an entry whose finding the ledger has RESOLVED fails as
contradicted.

Widening the scan to entities immediately paid for itself twice:

- **16 entity columns** carry literal DDL defaults that disagree inside one
  service — farm-service alone has `'TRY'`, `'NOK'` and `'USD'` on sibling
  tables. That is the FARM-MEDIUM-145 drift one layer below where it was fixed.
  Registered as **FARM-MEDIUM-327**; not fixed here (16 migrations across four
  services plus a NOT NULL audit each). The precedent for the fix is in this
  same branch: HR-HIGH-008's migration `1802200000000` _drops_ the default
  rather than correcting it, because a column default cannot know the tenant.
- **`work-order.entity.ts:541`** — the one a handler-only scan could never see,
  and the only live member of the set. `work_orders.currency` is nullable with
  no default while the derived `costSummary` jsonb requires a non-null
  `currency`, so `updateCostSummary()` stamps `'TRY'` on every work order
  created without one, whatever the tenant uses.

Each rule was mutation-tested rather than assumed: a new literal in an
unlisted handler fails test 2, removing a literal without removing its exemption
fails test 3, and pointing an exemption at a RESOLVED finding fails test 4.
