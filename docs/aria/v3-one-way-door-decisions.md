# Plan ARIA-V10.6 — One-Way Door Decisions Risk Enumeration

**Branch:** `snowball` **Phase:** Plan ARIA-V9 + V10 v3 — V10.6 (one-way-door decisions doc)
**Status:** RESOLVED — closes architectural-arbiter Theme A finding (one-way doors unlabeled).

## What this doc records

The 4-validator audit on the v3 plan flagged that several architectural decisions in V9+V10 are
**one-way doors** — irreversible without significant cost. Each entry below identifies the decision,
the irreversibility class, and the reversibility cost should it need to be undone.

## 1. EVENT_TYPES whitelist extension (V9.0-B)

**Decision:** Extended `plan_convergence.EVENT_TYPES` with 5 new types: `implementation_requested`,
`implementation_started`, `implementation_outcome_recorded`, `implementation_merged`,
`implementation_rejected`.

**Why one-way:** Every row in `events.jsonl` is content-hashed via `_idempotency_key`. Renaming or
removing a recorded `event_type` invalidates the audit chain for every plan that has emitted such an
event. The append-only ledger semantically anchors these strings.

**Reversibility cost:** A ledger migration with hash-chain re-keying. Effort: substantial — every
existing autonomy run's events.jsonl must be re-canonicalized + the cache invariants in
`_FOLD_PLAN_STATE_CACHE` must be cleared.

**Mitigation:** None feasible. The closed enum is the cost of safety.

## 2. TERMINAL_STATES extension (V9.0-B)

**Decision:** Added `IMPLEMENTATION_MERGED` and `IMPLEMENTATION_REJECTED` to `TERMINAL_STATES` while
preserving `CONVERGED` as terminal (V8 invariant).

**Why one-way:** Same as EVENT_TYPES — every `state.terminal_state` value lands in audit rows.
Removing a value orphans the audit history.

**Reversibility cost:** A ledger migration + cache invalidation. The V8-active-plan filter
(`list_active_plans`) uses `TERMINAL_STATES`; any change ripples to the active-plan cache.

**Mitigation:** Future V11+ work can ADD terminal states (forward-compatible); removal requires the
migration.

## 3. `snowball` branch as base for aria-implementer PRs (V9.1)

**Decision:** Every aria-implementer PR opens with `--base snowball`. The `aria-impl-<hex16>`
feature branch is created per cycle.

**Why one-way:** Once merged PRs accumulate, the snowball commit history carries every
implementer-authored commit. Moving the base to a different branch (e.g. `aria-snowball`) would
require rebasing the entire ARIA history.

**Reversibility cost:** A branch rename + remote ref rewrite + every downstream consumer (CI
workflows, branch protection rules, GitHub App installation scope) must be updated.

**Mitigation:** The `--base` value is a configuration constant on the `aria-implementer` agent file
(V9.1) and the V9.0-D `ALLOWED_BASH_COMMANDS` regex `^gh\s+pr\s+create\s+--base\s+snowball`.
Changing the base is a coordinated, multi-commit operation but possible.

## 4. `pattern_signature` hashing rule (V10.2)

**Decision:** V9.4 `compute_pattern_signature` hashes `(affected_surfaces, key_change_categories,
validation_command_set)` after canonical normalization. V10.2 skill-genesis activation triggers on
N=5 consecutive matching signatures.

**Why one-way:** Once cycles record `pattern_signature` values in `governance.jsonl`, switching the
hashing rule orphans every prior signature. Skill-genesis history becomes uncomparable across the
boundary.

**Reversibility cost:** A signature-recomputation pass over historical governance rows + cache
invalidation of the V10.2 lookback window. Roughly: rerun `compute_pattern_signature` on every
historical plan_content, append a new row carrying both `pattern_signature_v1` +
`pattern_signature_v2` until the boundary cycle.

**Mitigation:** The signature has a `schema_version` field in its input canonical dict. Adding a
`schema_version=2` lets new cycles emit a new signature shape while old rows still verify under v1.
Tier-2 escape hatch.

## 5. `PlanCandidateSource` enum (V9.0-A)

**Decision:** Closed 5-member enum: `OPERATOR_FEEDBACK, FAILING_CI, ORPHAN_FINDING, F_FINDING,
GIT_DIFF`. String values are lowercase_snake_case + stable.

**Why one-way:** These string values land in `governance.jsonl`, `cost-attribution.jsonl`, and
`pressure-source-effectiveness.jsonl`. Renaming a value silently breaks every downstream rollup +
dashboard.

**Reversibility cost:** A ledger-rewrite migration + dashboard reconfiguration. Adding a new member
is forward-compatible (just extends the enum); removing or renaming a member is the painful
operation.

**Mitigation:** I-V9-PRESSURE-01 invariant pins the exact 5-member set + lowercase_snake_case values

- disjointness from `pressure.py` SOURCE_WEIGHTS. A refactor that drops a member would fail CI
  before merge.

## 6. Ledger line budget — one writer-side constant (Plan 032 Faz 032a)

**Decision:** `ledger.LEDGER_ROW_MAX_BYTES` (1 MiB) is enforced at append time by
`_append_jsonl_locked_body` (`LedgerRowTooLargeError`), and every reader that caps a line
(`state_snapshot.SNAPSHOT_LEDGER_ROW_MAX_BYTES`, `fixture_runner.FIXTURE_RUN_LEDGER_MAX_LINE_BYTES`)
imports that constant.

**Why one-way:** An append-only hash chain cannot be shrunk after the fact; a row above the reader's
cap makes the whole surface unpublishable (run 33608801135, 2026-09-02). Lowering the constant later
would orphan already-chained rows; raising it re-admits the failure class.

**Reversibility cost:** Any change needs a `grandfather_line_prefixes`-style migration over every
published ledger plus a snapshot re-verification.

**Mitigation:** I-V12-LEDGER-01/02 pin write-time refusal and reader/writer identity.

## 7. `write_driving_surface_reset` governance kind + release-reason prefix tables (Plan 032 Faz 032a)

**Decision:** A write-driving ledger restarting from empty is recorded as a
`write_driving_surface_reset` governance row carrying the archived surface hash and an operator
approval (`memory_gap.record_surface_reset`). Release-reason fault ownership is by literal OR prefix
(`HARNESS_FAULT_RELEASE_REASON_PREFIXES`, `REQUEST_FAULT_RELEASE_REASON_PREFIXES`); an unclassified
reason still charges the request and lands an `unclassified_release_reason` row.

**Why one-way:** Both strings land in `governance.jsonl`; the prefix tables decide whether a
claims-ledger row counts toward HUMAN_REQUIRED, so renaming either rewrites derived history.

**Reversibility cost:** Ledger-rewrite migration of governance kinds + re-derivation of every
request state.

**Mitigation:** I-V12-RELEASE-01/02/03 and I-V12-STATE-03 pin the vocabulary and the ceremony.

## 8. Single ledger authority is the `aria/state` transport (Plan 032 principle 1)

**Decision:** Every producer (GHA lanes, executor, any future daemon) appends through the kernel's
locked, hash-chained writers and publishes ONLY through `state_store.publish_with_contention_replay`
(fast-forward-only branch + deterministic suffix replay). No producer keeps a private chain head or
a second publish path.

**Why one-way:** Two publish paths around one hash-chained ledger is how the ledger diverges
(`tests/invariants/aria-single-restore-path.spec.ts` already pins the restore half of this).

**Reversibility cost:** A second authority would require a new transport with its own ancestry proof
and a migration of every consumer.

**Mitigation:** The gateway/daemon phases (032f) add an invariant that daemon code imports no
publish primitive other than the store API.

## 9. Hook decision + work-journal ledgers (Plan 032 Faz 032b-2)

**Decision:** Two new declared surfaces: `hooks/decisions.jsonl` (every PreToolUse verdict) and
`agent-invocations/work-journal.jsonl` (one SANITIZED row per completed tool call: `command_family`,
`argv_redacted`, `command_hash`, `external_effect`, `files_touched` — never the raw command). The
journal is write-driving: Faz 032c recovery reads it.

**Why one-way:** Both are hash-chained ledgers published to `aria/state`; the journal's field set is
what recovery and the session fingerprint reason over.

**Reversibility cost:** A rewrite migration of both surfaces plus every reader of `command_family` /
`external_effect`.

**Mitigation:** I-V12-HOOK-03/04 pin the row shape and the redaction;
`command_policy.COMMAND_FAMILIES` is a closed vocabulary.

## 10. `RELEASE_REASON_CODES` (Plan 032 Faz 032b-3)

**Decision:** Claim release/requeue rows carry `reason_code` (closed vocabulary in
`release_reason.py`), `reason_detail` and `fault_domain` next to the legacy `reason` string.

**Why one-way:** Ledger-anchored strings on `agent-invocations/claims.jsonl`; `fault_domain` is what
the requeue budget reads.

**Reversibility cost:** Ledger rewrite + re-derivation of request states.

**Mitigation:** I-V12-REASON-01/02 pin the mapping and the row fields; adding a code is
forward-compatible, renaming one is not.

## 11. Checkpoint, session, external-effect and recovery ledgers (Plan 032 Faz 032c)

**Decision:** Four declared surfaces — `checkpoints/index.jsonl` (refs `refs/aria/<request>/<seq>`
in a shadow store OUTSIDE the workspace), `agent-invocations/sessions.jsonl` (claim ↔ Claude session
id + fingerprint), `recovery/external-effects.jsonl` (intent/receipt pairs with `idempotency_key`),
`recovery/decisions.jsonl` (closed `RECOVERY_DECISIONS`). `EXTERNAL_EFFECT_KINDS` and the
fingerprint inputs are closed.

**Why one-way:** Recovery decides from these rows whether a request is re-run, resumed or handed to
a person; the fingerprint's input set defines when a session may be resumed.

**Reversibility cost:** Ledger rewrite plus re-deriving every pending recovery decision.

**Mitigation:** I-V12-CKPT-01..05, I-V12-SESS-01..03, I-V12-RECV-01..04 pin the shapes;
`POLICY_VERSION` is part of the fingerprint so a policy change invalidates resumes by construction.

## 12. `DELIVERY_STATES` + the scoped credential rides the spawn env (Plan 032 Faz 032d)

**Decision:** `delivery_closure.DELIVERY_STATES` is a closed vocabulary derived only from effect
ledgers; `DELIVERED_STATES = {ci_green, merged}` is the definition of "verified". Exactly one
runtime profile (`implementer`) carries `external_writes`; its GitHub credential is the
`gh_token_factory` lease placed in ONE spawn's built environment as `GH_TOKEN` (+ env-only git
credential helper) and revoked when the spawn ends — the earlier "credentials file the sandbox
reads" design is superseded. Intent/receipt rows written from inside a spawn are keyed on
`ARIA_REQUEST_ID`.

**Why one-way:** The SLO that gates 032e+ (verified PRs ≥ 3, false-success 0, duplicate 0) is
computed from these states; the credential path is what every implementer PR in the ledger will have
been produced under.

**Reversibility cost:** Re-deriving every delivery record; re-keying intent rows written under the
request id.

**Mitigation:** I-V12-DLV-01..07 pin the grant's singularity, the names-only governance rows, the
executor bracket (issue → export → revoke) and the state derivation.

## 13. Operator control ledger, `CANCELLED_BY_OPERATOR`, notification outbox (Plan 032 Faz 032e)

**Decision:** `control/commands.jsonl` with closed verbs `pause|resume|cancel` (cancel sticky, per
request); derived terminal state `CANCELLED_BY_OPERATOR` bound to the control ledger, not to a claim
row; release reason `operator_cancelled` is the OPERATOR fault domain (never a requeue burn).
`notifications/outbox.jsonl` with closed `NOTIFY_EVENT_KINDS`/`NOTIFY_CHANNELS`/`NOTIFY_STATUSES`;
`run-artifacts/hot/<request>/progress.jsonl` as the sanitized progress ledger.

**Why one-way:** Every consumer of request state (drain, doctor, telemetry, compaction) treats
`CANCELLED_BY_OPERATOR` as terminal; alert rules and dashboards are keyed on the outbox and
telemetry series.

**Reversibility cost:** Re-deriving request states for every cancelled request; rewriting alert
rules.

**Mitigation:** I-V12-CTRL-01..04, I-V12-PROG-01, I-V12-NOTIFY-01, I-V12-TELEM-01, I-V12-OPS-01.

## 14. Gateway vocabularies + `PlanCandidateSource.GITHUB_ISSUE` (Plan 032 Faz 032f)

**Decision:** `gateway.normalize.EVENT_KINDS`, `gateway.router.ROUTE_ACTIONS` and
`gateway.scheduler.SCHEDULE_ACTIONS` are closed; the schedule table can never carry a free prompt.
`gateway/inbox.jsonl` (accepted/routed/rejected per delivery id) and `gateway/schedules.jsonl` are
declared ledgers. `PlanCandidateSource` gains exactly one member, `GITHUB_ISSUE` (mission
`source_kind="github_issue"`), ranked at the FAILING_CI tier.

**Why one-way:** Inbox rows are replayed by the router and audited by the doctor; the
candidate-source member set is pinned by I-V9-PRESSURE-01 and consumed by the synthesizer's ranking.

**Reversibility cost:** Re-routing every inbox row; re-ranking candidates; rewriting the
pressure-source invariant.

**Mitigation:** I-V12-GW-01..06. Amendment 2026-09-03: `experiment_night` (→
`experiment_night.run_night_experiments`) joined the vocabulary and `adapter_run:<tool_id>` is the
ONE parameterised form — the parameter is a tool id validated against the registry's ACTIVE set
(`scheduler.validate_action`), never text.

## 15. MCP registry, strict per-spawn config, call ledger + quarantine (Plan 032 Faz 032g)

**Decision:** `aria_kernel/data/mcp_registry.json` is the only source of MCP servers an autonomous
spawn may load; every spawn carries `--strict-mcp-config` with a kernel-written document (profile's
`mcp_servers` minus quarantined). `mcp/tool-calls.jsonl` and `mcp/quarantine.jsonl` are declared
ledgers; the quarantine rule (≥10 calls, error rate ≥ 0.5 over the last 50) and the `mcp__<server>`
/ `mcp__<server>__<tool>` deny projection are fixed. The kernel's own server exposes a closed
read-tool set; write tools require `--allow-writes` + an approval ref recorded on governance. CLI
floor 2.1.221.

**Why one-way:** Runtime profiles, hooks and the doctor derive MCP exposure from these rows; an
agent that once had a server cannot be argued to have had another.

**Reversibility cost:** Re-projecting every profile's tool rules; rewriting the health fold.

**Mitigation:** I-V12-MCP-01..05.

## 16. Curation is proposal-only; executor concurrency is policy (Plan 032 Faz 032h)

**Decision:** `skill-genesis/curation-proposals.jsonl` with closed `CURATION_KINDS =
PROPOSE_ARCHIVE|PROPOSE_MERGE` and `CURATION_DECISIONS = accepted|rejected` (operator ref required);
no code path archives or merges a skill on its own. `genesis_policy.executor` (`max_concurrent`
clamped to [1, 8], `worktree_per_request`) is the only way to run more than one drain child; raising
it above 1 is an operator decision after the 032d SLO has held.
`docs/aria/generated/harness-parity.md` is generated from `harness_parity.PARITY_TABLE` and must
match it.

**Why one-way:** The panel/veto promotion path is the trust boundary for skills; parallel children
share nothing but the store, so the policy block is what bounds contention.

**Reversibility cost:** Re-keying proposals; re-validating every parallel-safety assumption.

**Mitigation:** I-V12-SKILL-01..03, I-V12-PAR-01..02.

## 17. Decision memory in the sealed prompt, economy ledger, authority surfaces (Plan 032 Faz 032i)

**Decision:** `decision_memory` is a prompt-affecting request field (claim projection carries it;
the prompt hash seals it); `DECISION_SOURCES` and `GOVERNANCE_WHY_KEYS` are closed.
`economy/recommendations.jsonl` with closed `RECOMMENDATION_KINDS`/`RECOMMENDATION_ACTIONS`; the
governor lowers effort by ONE rung, never below `medium`, only while a recommendation is younger
than 7 days. `self_improvement.AUTHORITY_SURFACES` and `SELF_CHANGE_ALLOWED_PREFIXES` are the
boundary a self-change proposal can never cross; every proposal opens a HUMAN_REQUIRED adjudication.
`SCHEDULE_ACTIONS` extended by exactly `self_improve` and `economy`.

**Why one-way:** Prompt hashes minted with the pack are verified on every claim; effort downgrades
change what every spawn costs; the authority-surface list is the machine-readable form of "ARIA
never widens its own permissions".

**Reversibility cost:** Re-minting open requests; re-ledgering recommendations; a security review
for any surface removed from the list.

**Mitigation:** I-V12-MEM-01..02 (incl. the D4 embedder ranking + degradation test), I-V12-ECON-01,
I-V12-SELF-01..02.

## 18. Security foundations: CRITICAL severity, profile, prerequisite gate (Plan 033 Faz 033a)

**Decision:** `finding.SEVERITIES` gains `CRITICAL` as the top rank (added at the front, existing
ranks preserved). `security/profile.jsonl` is a declared, content-addressed Repository Security
Profile with a closed `PROVENANCE` (`OBSERVED|INFERRED|OPERATOR_ASSERTED`) and closed
`ISOLATION_STRATEGIES`; the profile answers "what exists" and carries NO attack authorization.
`security prerequisites` is a fail-closed gate over a closed `REQUIRED_CAPABILITIES` list — no
security campaign runs on a kernel missing a Plan 032 capability.

**Why one-way:** Severity ranks are compared across the finding pipeline; the profile digest feeds
pack selection and campaign identity; the prerequisite list is the safety floor for every later
phase.

**Reversibility cost:** Re-ranking recorded findings; re-compiling every profile snapshot.

**Mitigation:** I-V13-SEVERITY-01..03, I-V13-SECPROF-01..05, I-V13-BOOT-01..04.

## 19. Security packs + SARIF ingest: closed, passive, untrusted-input (Plan 033 Faz 033b)

**Decision:** `packs.PACK_NAMES` is closed (`api`, `multi_tenant`); a pack is selected only when the
compiled profile says its surface exists, runs bounded deterministic rules, and emits UNVERIFIED
`external_scanner` leads (never canonical findings). `scanner_ingest.SCANNER_SOURCES` is closed
(Trivy=code-scanning, Gitleaks=artifact, Snyk/CodeQL/Semgrep=not_configured — never counted clean);
SARIF is untrusted (version/size/list checks, path-traversal and scheme URIs dropped, malformed
quarantined via governance). The RLS-coverage rule's exception allowlist is fixed.

**Why one-way:** Pack digests feed campaign identity; a lead's unverified trust grade is what keeps
scanner noise out of the canonical finding ledger; the source list decides what "measured" means.

**Reversibility cost:** Re-running every pack; re-classifying ingested signals.

**Mitigation:** I-V13-PACK-01..05, I-V13-SARIF-01..04.

## 20. Attack graph (versioned) + assurance coverage (honest) (Plan 033 Faz 033c)

**Decision:** `attack_graph` snapshots are content-addressed and bound to (repo SHA, profile digest,
pack digests, built_at, staleness horizon); the full graph is an artifact, the ledger holds the
digest + counts; a graph past its horizon is STALE and may not drive a campaign. `assurance` has a
closed status vocabulary; coverage folds against the APPLICABLE (asset, control) set — never a
Cartesian product — and a once-clean cell whose evidence is no longer fresh reads STALE, never
clean. Fleet-ready = required cells with not_tested = 0, unknown = 0 and zero confirmed
vulnerabilities.

**Why one-way:** Campaign identity binds a graph digest; the coverage verdict is the honest
substitute for the un-provable "no vulnerabilities" claim.

**Reversibility cost:** Re-deriving every graph; re-folding coverage against a changed cell set.

**Mitigation:** I-V13-GRAPH-01..02, I-V13-STALE-01, I-V13-ASSURE-01..02.

## 21. Security scope policy, ephemeral lab, persona broker (Plan 033 Faz 033d)

**Decision:** `scope_policy.RISK_CLASSES` (R0..R4) and `CEILINGS` are closed and repo-owned; the
production deny inventory lives at `infrastructure/aria/security-lab/production-deny-inventory.json`
and an unreadable or incomplete inventory caps automatic risk at R0 (fail-closed). Every target that
is not inside the campaign's own lab network — production hosts, metadata, loopback, link-local,
public, out-of-scope private, partially-rebinding hosts — is `R4_FORBIDDEN`. A lab lease can only be
written by a `TRUSTED_PROVISIONERS` identity (no register-target CLI exists); images must be sha256
pinned; attestation refuses lab/production overlap; a campaign needs a clean teardown receipt.
Persona secrets never enter a ledger.

**Why one-way:** these are the boundaries the whole active lane trusts; loosening any of them is a
production-safety change, not a feature.

**Reversibility cost:** Re-attesting every lab; re-auditing every grant issued under the old policy.

**Mitigation:** I-V13-SCOPE-01..02, I-V13-LAB-01..02, I-V13-TEARDOWN-01, I-V13-PERSONA-01.

## 22. CampaignGrant (EdDSA JWS), Evidence Vault, campaign lifecycle (Plan 033 Faz 033e)

**Decision:** the CampaignGrant is the ONLY cryptographic signature in ARIA: compact JWS with
`alg=EdDSA` (any other alg/typ, a bad signature, an expired or not-yet-valid window, a mismatched
bound digest, an R4 class or an R3 class without a human approval ref bound to an exact recipe
digest is refused); the private key lives outside the workspace; a JTI activates for exactly one
`campaign_run_id`. Raw security evidence never enters a ledger, Git or `aria/state`: the ledger row
is metadata + digest + redacted preview + ref, the bytes go to an AES-256-GCM vault outside the
workspace and tools dir (per-campaign DEK wrapped by a KEK read from an FD), truncated objects are
flagged, seals are write-once, purges leave receipts. `campaign.STATES` / `TRANSITIONS` /
`REQUIRED_INPUTS` are closed and ordered; inputs are write-once; cleanup without a teardown receipt
quarantines; CLOSED only after CLEANUP_VERIFIED. `mission.BINDING_KEYS` gains `campaign_run_ids` +
`grant_jtis`. If the signing/AEAD backend is missing the lane fails closed.

**Why one-way:** these are the trust anchors the policy proxy and every campaign verdict rely on.

**Reversibility cost:** Re-issuing every grant under a new scheme; re-encrypting the vault.

**Mitigation:** I-V13-GRANT-01..02, I-V13-VAULT-01, I-V13-CAMPAIGN-01..02.

## 23. Typed probes, policy proxy (single egress), ZAP under policy (Plan 033 Faz 033f)

**Decision:** the LLM never receives network bash. An `AttackRecipe` is a CLOSED list of typed steps
(`probe.STEP_KINDS`); any step key in `FORBIDDEN_STEP_KEYS` (shell/script/python/command/…), a
mutation above its risk floor, a hostless HTTP/GraphQL step, a recipe without a positive control +
assertion, or a mutating recipe without cleanup is refused. `probe.evaluate` folds into the closed
`PROBE_VERDICTS`; a missing/failed positive control is HARNESS_ERROR and truncation/unreachability
is never clean. The `policy_proxy.PolicyEngine` is the single egress: it re-validates the grant on
every hop — scheme, exact host allowlist, DNS answer pinned to the first-seen IP set (rebinding →
deny), metadata/loopback/out-of-lab addresses (via scope_policy), body size, atomic budget, GraphQL
effect catalog (unknown mutation root field / persisted query → deny), no credential cross-origin
forwarding, redirect depth; `stop()` denies everything after. ZAP runs only from a sha256-pinned
image (`zap.pin.json`; floating tag / missing pin fails closed — ARIA never invents a digest) with
an Automation-Framework-allowlisted plan scoped to grant hosts; alerts are UNVERIFIED leads.

**Why one-way:** this is the containment boundary for all active traffic; a gap here is a real-world
egress, not a bug.

**Reversibility cost:** Re-running every active probe through a changed gate; re-pinning ZAP.

**Mitigation:** I-V13-PROBE-01, I-V13-NETGATE-01, I-V13-SSRF-01, I-V13-CANCEL-01, I-V13-ZAP-01.

## Themes

- **3 of 5 one-way doors are ledger-anchored** (events, terminal states, candidate sources). The
  append-only audit-chain semantics are the load-bearing safety guarantee that makes them irreversible
  without migration.
- **1 of 5 is branch-anchored** (snowball as base). The cost is in coordinated infra updates, not
  data migration.
- **1 of 5 is hash-anchored** (pattern_signature). Tier-2 mitigation via `schema_version` field.

## Invariants

- I-V10-MEM-04 — hash-chain integrity at every `lookup_pattern` call
- I-V9-PRESSURE-01 — `PlanCandidateSource` exact member set
- I-V9-EVENT-01 — `EVENT_TYPES` contains the 5 V9 implementation types
- I-V12-LEDGER-01/02 — ledger line budget binds at write time; readers import the writer's constant
- I-V12-RELEASE-01/02/03, I-V12-STATE-03 — release-reason prefix ownership; surface-reset ceremony
- I-V9-STATE-01 — `TERMINAL_STATES` contains both V9 terminal states
- V9.1 frontmatter pin — agent file references `--base snowball`

Future ADRs touching any of these decisions MUST cite this doc + carry an explicit migration plan.
