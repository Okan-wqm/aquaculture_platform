# ARIA post-chain plan — what the chain's closure does not cover

Recorded 2026-09-14 while the live chain (rings 1–7) was being closed. The operator's direction:
note the gaps the architecture review named, start from the most important, plan and implement
each — **after the chain runs end to end**. Every item is a registered finding with an owner and a
deadline; the order below is the execution order.

**Revised 2026-09-14 (evening), from the session that closed HIGH-115/117/123 and ran HIGH-124 to
its fourth adversarial round.** Every ring that touched a live process surfaced a defect its tests
had mocked away (117, 123, 124's five, 134); the kernel lane on main had been red for days with
every watchdog red and nobody acting; a single HIGH cost a day because the pre-push suite runs
three hours on the shared host. The plan now starts with those three facts — one real external
task, a suite the loop can afford, and a human who actually reads the organs — before it builds
measurement on top of them.

| #   | Finding                                                                                                                                                 | Why here                                                           | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------- |
| 0   | ARIA-HIGH-137 — external task zero                                                                                                                      | the chain has only ever carried ARIA's own changes                 | live chain |
| 1   | ARIA-HIGH-136 — the kernel suite the loop can afford                                                                                                    | one HIGH per day is the loop's real speed today                    | —          |
| 2   | ARIA-MEDIUM-127 — operator inbox                                                                                                                        | every organ writes; nobody reads (main red for days, unseen)       | —          |
| 3   | ARIA-HIGH-138 — real-process doctrine for every seam                                                                                                    | the false-close class: green tests over a mocked seam              | —          |
| 4   | ARIA-MEDIUM-131 — broker adversarial review                                                                                                             | the new privileged boundaries were reviewed only by their own lane | —          |
| 5   | ARIA-MEDIUM-139 — a runner that confines and is not production                                                                                          | hosted cannot confine; the droplet is Suderra                      | operator   |
| 6   | ARIA-HIGH-125 — nightly fitness (goldset precision/recall) + signed training-set export                                                                 | the RSI ladder has no "better" without it                          | 0          |
| 7   | ARIA-HIGH-126 — the target repo's test floor (CI quarantine)                                                                                            | ARIA's breakage detection is blind there                           | 0          |
| 8   | ARIA-MEDIUM-128 — deadlines organ (early warning)                                                                                                       | landed `ba6dc5fda8`                                                | —          |
| 9   | ARIA-HIGH-122 — the adaptation loop                                                                                                                     | kernel adapts to a changed condition instead of waiting            | 1, 6       |
| 10  | ARIA-MEDIUM-129 — memory usefulness (A/B: the second task with and without the first task's outcome row; the plan must cite it, or nothing was learned) | "ARIA learns" becomes measurable                                   | 0, 6       |
| 11  | ORPHAN-HIGH-689 — genesis EVAL_WINDOW → ACTIVE (measured promotion)                                                                                     | RSI rungs 2–3                                                      | 6, 9       |
| 12  | ARIA-MEDIUM-130 — CI proves containment                                                                                                                 | the security property CI cannot defend                             | 5          |
| 13  | ARIA-MEDIUM-132 — regression → revert candidate                                                                                                         | a broken main should not wait a night                              | live chain |
| 14  | ARIA-HIGH-133 — kernel separable from the target repo                                                                                                   | the Legal/finance product line                                     | 0–3        |
| 15  | ARIA-HIGH-108b / 109b — provider continuity for write roles                                                                                             | "any live subscription keeps the chain moving"                     | live chain |

Fixed lines the plan keeps: fitness is measured, never self-reported; the gates that judge the
kernel (judges, merge predicates, signature verification) stay operator-approved; the model-tier
write protection stays; every promotion is reversible and its reason is on the ledger. Added: a
seam is proven by a real process, not by a mock of it (ARIA-HIGH-138); "the chain is closed" is
said only when ARIA has carried one of its own changes to merge with no manual repair, and "ARIA
works" only after external task zero (ARIA-HIGH-137).

**Brakes against over-engineering (operator, 2026-09-14: "yapılması gerekenin yapılmasını
istiyorum, over-engineering'den korkuyorum").** Three rules every lane from here on is held to;
ARIA-HIGH-136 pins the first, the lane's verifier applies the other two:

1. **Runtime and duplication budget, not a test count.** A lane may add tests; the suite's
   measured runtime may not cross the ARIA-HIGH-136 target, and a new test that re-proves what an
   existing one already proves is refused in review. The target is fewer minutes and fewer
   duplicates with the important failure classes still covered — never fewer tests for its own
   sake.
2. **Round ceiling with two doors.** An adversarial round continues on a defect the verifier
   REPRODUCED, or on one it proved from the code — a file:line chain showing the defect is
   reachable in production. A security defect evident in the code is a must-fix without a run.
   "Could happen" with neither door is an observation, and observations do not open a round.
3. **Evidence, not prose.** A commit message or a CONTRACTS paragraph says what changed, why, and
   how it was proven — three sentences; the rest lives in the finding's section. The seam
   registry of ARIA-HIGH-138 is a reduction tool: one real-process pass replaces the mocked tests
   that only ever agreed with each other.
4. **A finding met on the way is closed at its class, not its architecture.** Every refusal
   external task zero meets gets the smallest root-cause fix that closes its class; it becomes an
   architecture item only when the class recurs or sits on a security boundary. The chain is
   proven by finishing a task, not by the findings it generates.

Deferrable without cost returning, by the operator's call: 131 (after external task zero) and
139 (until the droplet shows production impact). Not deferrable: 136, 137, 138, 127.

## ARIA-HIGH-136 — the kernel suite the self-change loop can afford

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-10-05
- **Evidence:** 6,484 tests; `Ran 6484 tests in 2901 s` on a hosted runner (PR #1553), 11,298 s
  for 171 "affected" modules in push #7's pre-push on the shared droplet, 231 modules for push #8.
  `scripts/ci/aria-suite-changed.mjs` is over-inclusive by design, so a kernel change selects most
  of the suite; every lane in this session waited 2–3 hours per push and a single HIGH took a day
  of wall clock. ARIA-HIGH-122's adaptation loop and ORPHAN-HIGH-689's promotions each need a
  self-change to validate inside a night; at this speed neither fits.
- **Where the time goes (measured 2026-09-14):** the hosted runner (4 vCPU, nothing else
  running) ran all 6,484 tests in 2,902 s; the droplet (4 cores, two lane agents and production
  beside it) ran the 2,512-test affected subset in 11,298 s — roughly ten times slower per test.
  Contention is the first lever, the suite's own length the second; setup is not one (the hosted
  lane's install and checkout take two minutes of fifty).
- **Fix shape (tier 2), in the order the measurement dictates:** (1) a push's pre-push suite and
  a lane's adversarial battery never share the host — sequenced by the operator loop until
  ARIA-MEDIUM-139 gives the gate its own machine; (2) the suite runs in parallel by module
  (`pytest-xdist` / process pools, with the per-process scratch dirs `tests/__init__.py`
  already provides — 4 workers on 4 cores); (3) one instrumented run (`--durations`) names the
  slowest modules and the seam-proving tests (real bwrap/git/socket — slow, few) move to a slow
  tier the lane owns while the fast tier answers in minutes; (4) the affected selector reads the
  import graph instead of text mentions — a modest gain, because the kernel's hubs (`cli.py`,
  `ci_executor.py`) legitimately reach most of the suite. Targets, pinned by a test over the
  lane's timing ledger: pre-push affected run under 30 minutes on the droplet, the hosted lane
  under 25; measured before and after on the same selection, or no claim. The hosted lane's
  `timeout-minutes` shrinks with the measurement, never ahead of it.

## ARIA-HIGH-137 — external task zero

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-25
- **Evidence:** every CONVERGED plan and every implementation the chain has carried was a change
  to ARIA itself (trials six–eleven, HIGH-115/117/123/124). The failure modes of a task in `apps/`
  — `nx affected --target=test` over real services against the 45-minute canonical ceiling,
  `format:check` over the whole repo, domain fixtures, schema-declaration invariants — have never
  met the executor, the apply gate or the merge predicates. "ARIA works" cannot be said from the
  kernel's own repairs.
- **The task (chosen 2026-09-14):** trial eleven's CONVERGED plan `flow-083f26574cade7dee7fc`
  (tier 1): `web/shell/src/hooks/useNotifications.ts` marks a notification read locally without
  reading the mutation's result, and `apps/notification-service` specs pin the contract — two
  source files, five specs, inside the self-merge scope (`auto_merge.py`: `apps/**/src/**`,
  `web/**/src/**`). No new planning, no new store.
- **Success, failure and the permitted human, defined before the run:** success is the executor
  lane (the trial harness until PR-3 is on main) producing a signed commit, a kernel-stamped
  `pr_url` on a real PR, the judge's verdict folded (ARIA-HIGH-097), the merge predicates
  answering, and a `merge-outcomes` row — with no hand on the store, the branch or a ledger.
  The permitted human acts are the cycle's `operator_approval_ref` and, if branch protection
  demands it, the PR review and merge click; nothing else. Any manual rescue makes the run a
  failure: it is recorded under this section as its own line (what was touched, why), becomes a
  finding closed at its class (brake 4), and the task runs again. The section closes with the
  plan id, the PR number and the merge outcome.

## ARIA-HIGH-138 — a seam is proven by a real process, not by a mock of it

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-10-05
- **Evidence:** HIGH-117 (the maintenance lane's compaction), HIGH-123 (git inside the sandbox),
  HIGH-124 (the apply gate, `pr create`, MCP and the kernel package's own import path inside the
  sandbox), ARIA-MEDIUM-134 (the suite on a host other than the droplet) — each was green under
  tests that mocked exactly the process that failed live. The class is the one ORPHAN-694 named:
  a mechanism is added and pinned, and nothing asks whether the production path reaches it.
- **Fix shape (tier 3):** a closed registry of seam modules (`implementation_safety`,
  `git_containment`, `hook_broker`, `mcp_broker`, `signing_agent`, `implementation_delivery`,
  `state_compact` publish, the executor drain) and, for each, at least one test that runs the real
  process — real `bwrap`, a real linked worktree, a real unix socket, a real `ssh-agent`, the real
  executor child — marked as such; a test over the registry refuses a seam without a real-process
  pass and a seam module missing from the registry (AST walk over the spawn primitives). The lane
  that runs those tests is the one ARIA-MEDIUM-139 provides.
- **Inventory on 2026-09-14 (the registry's seed):** real process today —
  `test_executor_implementation_identity.py` (the real executor child under real bwrap, real git,
  a fixture `gh`), `test_git_containment.py`, `test_hook_broker.py` (a real unix socket),
  `test_signing_agent.py` (a real `ssh-agent`), `test_containment_probe.py`,
  `test_managed_claude_sandbox.py`, `v3_1/test_phase_v31_p_linked_worktree_signing.py`,
  `test_suite_env_hermeticity.py` (a fresh interpreter). Mocked boundary today — the managed
  `claude`/`codex` CLIs (`test_ci_executor_native_claude.py`, `test_ci_executor_provider_undecided.py`:
  fixture CLIs), GitHub (`test_pr_manager_e2e.py`, `test_merge_authority_*`: fixture `gh`, fixture
  PR state), the memory hook and judge lanes (scripted agent answers), `state publish` (a fixture
  bare remote). The critical transition no test makes real: the managed CLI committing inside the
  sandbox → the executor publishing → a real `gh pr create` → the merge authority reading a real
  PR → the outcome row. That transition is rings 4–6 of the chain, and ARIA-HIGH-137 is the only
  place it is proven.

## ARIA-MEDIUM-139 — a runner that confines and is not production

- **Severity:** MEDIUM · **Owner:** okan (decision) / claude (wiring) · **Deadline:** 2026-09-30
- **Evidence:** the hosted Ubuntu 24.04 image keeps unprivileged user namespaces under AppArmor,
  so the kernel lane that now proves the real sandbox (ARIA-MEDIUM-134) may not be able to confine
  there without a host change the lane must not make on its own; the only host that confines is
  the self-hosted runner — the production droplet (Suderra, 36 containers), where this session's
  harness already killed processes for memory and where the executor lane will run ring 4–6 live
  beside the tenants.
- **Decision for the operator:** a small dedicated runner VM (label `[self-hosted, linux, claude]`
  plus a kernel-CI label) that carries bubblewrap, the managed CLIs and nothing of production;
  the kernel lane and the executor lane move there; the droplet keeps only what serves tenants.
  Until decided, the kernel lane's verdict on hosted CI is whatever `ensure-sandbox-backend`
  reports, and PR-3 does not merge on a red kernel lane.
