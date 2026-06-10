# SENS API Gateway — train debt surfaced by #361 (2026-06-10)

**Context.** Dependabot PR #361 bumps five GitHub Actions and touches
`.github/workflows/sens-api-gateway-ci.yml`, which path-triggers the SENS API
Gateway CI for the first time since 2026-05-25. The run (27276980624, head
`c0367f74a` = current `main` + workflow-only bumps) exposed that **current
`main` itself does not pass the edge-crate CI**: the failures are pre-existing
platform debt, not bump effects.

## Findings

### EDGE-CRITICAL-001 — `main` merged edge-crate changes without SENS CI gating

PR #375 (enterprise train, merge `aa315130c`) changed three
`sens-api-gateway/src` files (`authz/in_memory_engine.rs`,
`commands/io_config.rs`, `provisioning.rs`), yet its head SHA `8cf513aef`
carries **zero** "SENS API Gateway CI" check runs — only the repository-root
`rust-ci` (sensor-ingestion crate) jobs ran and passed. The merge proceeded
because none of the SENS jobs ("Sens API Gateway summary", "cargo fmt --check",
"cargo test --all-targets", "cargo audit", "compile + test-compile gate") are
required status checks on `main`. Result: `main` shipped with rustfmt drift
and six failing typed-authz tests, discovered only when an unrelated
dependabot PR re-triggered the workflow 16 days after the previous run.

**Why it matters:** path-filtered workflows + non-required checks =
structurally silent merges. Any PR that touches the edge crate can merge red.

**Architectural fix (tier 3, make-it-detectable):** add the SENS summary job
to `main` branch protection required checks (GitHub settings — operator
action), so a PR touching `sens-api-gateway/**` cannot merge until the
summary job reports. The summary-job pattern (single required check that
fans in path-conditional jobs and reports `success` when the path filter
skips the suite) is already used by `sens-enterprise-summary`; mirror it.

**Status:** OPEN — requires repository-settings change (operator). The code
breakage itself is closed by EDGE-HIGH-001/EDGE-MEDIUM-001 below.

### EDGE-HIGH-001 — TypedAuthzPort lacked the co-approver pathway after engine SSOT delegation

#375 correctly collapsed the duplicated two-person-integrity permission list
in `authz/in_memory_engine.rs` onto the canonical
`Permission::requires_two_person_integrity()` (which has included
`OpcUaWrite { .. }` since the 2026-04-29 decision: direct PLC writes change
physical process state). It also implemented engine gate 5 fully: missing
co-approver ⇒ `TwoPersonIntegrityMissing`; irrelevant/self/expired
co-approver ⇒ `PermissionNotGranted`.

But the OPC UA adapter half of that SSOT closure never landed:
`TypedAuthzPort::authorize_write` had no way to carry
`CoApproverEvidence`, so `ManifestBackedTypedAuthz` always built the
`AuthorizationRequest` bare. Consequences:

1. Six adapter tests in `opc_ua_server_typed_authz.rs` fail on `main`
   (`EngineDenied(TwoPersonIntegrityMissing)` on what the test thought was
   the allow path).
2. Every production OPC UA write is denied at gate 5 — silently, with a
   misleading test suite claiming the allow path works.

**Fix (this PR, tier 1, make-it-impossible):** the port now models the
ceremony — `authorize_write(.., co_approver: Option<CoApproverEvidence>)`;
the adapter threads evidence into `AuthorizationRequest::with_co_approver`;
the engine stays the sole decision point. The NodeManager write surface
passes `None` (an OPC UA client session carries exactly one operator
identity — there is no co-approval channel on this surface yet) and is
therefore **fail-closed by design, not exempted**: the new
`write_without_co_approver_is_fail_closed` test codifies that posture.
Fixtures bind a second operator so allow-path tests exercise the full
ceremony, and the allow-path asserts `two_person_integrity_verified()`.

**Follow-up (not in this PR):** when a signed co-approval envelope ceremony
is designed for the OPC UA surface, the port parameter is already in place.
Until then direct OPC UA writes deny — this is the intended floor semantics.

### EDGE-MEDIUM-001 — RUSTSEC-2026-0173: proc-macro-error2 unmaintained

`cargo audit --deny warnings` fails on RUSTSEC-2026-0173 (published
2026-06-07): `proc-macro-error2 2.0.1` is unmaintained. Chain:
`proc-macro-error2 ← defmt-macros ← defmt ← lorawan` (build-time
proc-macro host dependency; never reaches the shipped binary). Upstream has
no fix: `defmt-macros` latest (1.1.0, 2026-05-12) still depends on it.

**Fix (this PR):** documented ignore added to both authorities that the
2026-04-29 audit-policy comment requires to stay mirrored —
`sens-api-gateway/deny.toml` (entry EDGE-CI-007, owner platform-team,
deadline 2026-10-01, re-check on each defmt release) and the
`sens-api-gateway-ci.yml` audit job ignore list.

### Formatting drift (folded into EDGE-CRITICAL-001 evidence)

`cargo fmt --check` drift in `authz/in_memory_engine.rs:601` and
`commands/io_config.rs:357` — both #375 files that SENS CI would have
caught. Fixed by `cargo fmt` in this PR.
