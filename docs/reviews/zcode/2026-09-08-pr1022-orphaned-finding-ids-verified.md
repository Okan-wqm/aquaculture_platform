# The nine finding IDs PR #1022 could not carry — 2026-09-08

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `324c29e3f`.

## Why this record exists

`docs/reviews/infra-expert/2026-09-04-production-host-control-plane-integration.md` records that nine
of PR #1022's finding IDs collided with IDs main had since allocated to unrelated findings, and that
the branch rows were "preserved in full at `scratchpad/r1022/branch-findings.jsonl`".

**That path is not in the repository.** `scratchpad/` is not committed, so after the integrator's
container was reclaimed the nine rows survived only inside the still-open branch and as one-line
summaries in that table. None of them had a registry entry, an owner or a deadline — which is the
failure mode `CLAUDE.md` names when it says `docs/reviews/` without registry rows is audit theater.

This record closes that. Every one of the nine was recovered from
`origin/fix/production-host-control-plane` and re-verified against main.

## Result: eight of nine need no registry row

Only one has a live residual on main. Registering the other eight would misstate main's state.

| PR #1022 ID       | Verdict on main @ `324c29e3f`                                                                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INFRA-HIGH-084    | **Not applicable.** Constrains the ordering of a current-release marker publication. `scripts/deploy/droplet-up.sh` on main has no such marker — zero occurrences. The marker belongs to the excluded deploy-lane rewrite, umbrella `INFRA-HIGH-141`.     |
| INFRA-HIGH-086    | **Already fixed.** `production-host-control-plane.sh:2030-2055` recovers a `.source.<sha>.staging` directory, refuses a recovery without the exclusive host lock, and validates the stage name against an anchored 40-hex pattern.                        |
| INFRA-HIGH-087    | **Already satisfied.** `droplet-up.sh:496` captures `docker inspect --format='{{.Image}}'` from the live container — not a tag lookup — and `post-deploy-verify.sh:165-172` compares the digest manifest's sha256 against the one recorded in the ledger. |
| INFRA-HIGH-089    | **Already fixed.** `production-host-control-plane.sh:373-400` converges exactly the owner-pinned 0755 legacy shape below a non-writable ancestry, and `:478` refuses a release root that is neither 0700 nor that exact legacy mode.                      |
| INFRA-HIGH-094    | **Not applicable.** Same marker precondition as 084.                                                                                                                                                                                                      |
| INFRA-HIGH-104    | **Inside `INFRA-HIGH-144`.** PITR evidence envelope sizing is part of the WAL-G v3 chain, which that finding already tracks with owner `infra-expert` and deadline 2026-09-25.                                                                            |
| INFRA-HIGH-105    | **Already fixed.** `production-host-control-plane.sh:996-1110` upgrades a v1 legacy release journal under the host lock, and `:909` rejects a zero-migration rollback policy carrying supersession metadata.                                              |
| SUPPLY-HIGH-001   | **Already fixed.** The finding names `<1.1.16` and `3.0.0`–`5.0.6` as vulnerable. Main's root lockfile resolves `brace-expansion` to 1.1.18 (×7), 2.1.4 (×6) and 5.0.9 (×1) — every one outside both ranges.                                              |
| SENSOR-MEDIUM-058 | **Half true — the only live residual.** See below.                                                                                                                                                                                                        |

The five INFRA findings marked "already fixed" were fixed by the slice that landed: slice 1 carried
the branch's _repaired_ `production-host-control-plane.sh`, so the defects it describes were
resolved by the same commit that brought the file. They read as open only because the branch rows
were never closed.

## SENSOR-MEDIUM-112 — the one that survived, with its claim corrected

Re-raised as `SENSOR-MEDIUM-112`, because the branch's wording overstates it in one half and
understates it in the other.

**Overstated.** The branch says the test modules "omit the required lifecycle event emitter". That is
false on main: every `Test.createTestingModule` block for `ScadaPackageService` provides
`EventEmitter2`. Carrying that wording forward would have put a claim in the ledger that the code
contradicts.

**Understated.** The duplication is real and larger than recorded — **eight** blocks across **six**
spec files, not five across three. Reading found five in three files; the other three
(`deploy-archived-guard`, `deploy-edge-widget-boundary`, `pin-control-security`) were surfaced by
the invariant written for the fix, on its first run. That is the argument for the invariant existing
rather than the fix being a one-time tidy.

**Why it matters.** No spec asserted on the emitter — it was there because the constructor requires
it. Wiring that exists only to satisfy a constructor is wiring that will be forgotten when the
constructor changes, and the copy that forgets fails at DI resolution with an error naming a missing
provider rather than the behaviour under test. The signal points at the harness instead of at the
change that broke it, and the more copies there are the likelier one is edited while the rest drift.

- **Tier 2 (automatic).** `createScadaPackageHarness()` in
  `apps/sensor-service/src/process/services/__tests__/scada-package-harness.ts` is the one
  definition. It supplies the service, the emitter stub and both repository tokens, and appends
  whatever optional collaborators a case exercises — so the "degrades when the optional deps are
  absent" case still gets a genuinely bare service.
- **Tier 3 (detectable).** `tests/invariants/scada-package-harness-single-source.spec.ts` fails on
  any spec that lists `ScadaPackageService` inside its own `Test.createTestingModule`, checks the
  harness still supplies what a copy would have to remember, and asserts at least three specs use it
  so the rule cannot pass vacuously.

### Verification

- `nx test sensor-service`: **1207/1207** across 105 suites.
- **Mutation-verified both directions.** Re-introducing one inline module in
  `pin-control-security.spec.ts` fails the invariant and names that exact file (1 failed, 3 passed);
  restored, 4/4 pass.
- The emitter stub is returned from the harness rather than hidden, so a future test that does care
  about a lifecycle event can assert on it without re-declaring the module.

## What this record does not do

It does not reopen the eight. If a later reader disagrees with a verdict above, the branch rows are
recoverable from `origin/fix/production-host-control-plane` at
`docs/reviews/_registry/findings.jsonl` — the branch is still open, which is the only reason this
recovery was possible at all. A rescue file written to `scratchpad/` is not a preservation strategy.
