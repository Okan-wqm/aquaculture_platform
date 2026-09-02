<!-- markdownlint-disable MD013 MD033 -->
<!-- Historical review text preserves long evidence tokens and placeholders. -->

# D0 adversarial review — data, privacy, and security boundaries

## Verdict

`CHANGES_REQUIRED`

D0 correctly keeps legacy ARIA isolated, stays `VERIFYING`, makes Postgres current state the authority, writes
command/idempotency/effect/audit/outbox state transactionally, uses a durable inbox, and specifies strong
per-hop SSRF controls. However, six P1 data/privacy boundaries remain non-executable, and one privacy-relevant
finding owner is inconsistent with its sprint card. These gaps permit cross-workspace data access, pre-call
prompt disclosure, durable retention of rejected secrets, under-specified encryption custody, and ungoverned
raw incident capture/deletion while all documented phase exits still pass.

## Findings

### DATA-P1-001 — The `aria` schema and tenant/workspace storage boundary are not defined or gated

- **Evidence:** Repository policy requires every non-tenant-routed entity to declare `schema:`, prohibits
  `public`, requires scoped repositories, and requires schema-drift registration (`CLAUDE.md:6`,
  `CLAUDE.md:108-123`). The design only says Postgres is authoritative and stores `tenant/workspace` metadata
  on object references
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:133-137`). S03 asks
  generically for “Schema/migrations” but names neither the owning `aria` schema nor table-level placement,
  scoped repositories, RLS, composite ownership constraints, or object-reference authorization; its negatives
  are migration/rollback/uniqueness/orphan tests
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:29-39`). S04 tests the API access
  predicate, but not worker, scheduler, reconciliation, projection, or CAS access paths
  (`phases/P01.md:41-51`). The `ARIA-AUDIT-072` row promises tenant/workspace isolation while its owners omit
  S04 and S59, the only cards that name cross-workspace or tenant isolation (`FINDING-COVERAGE.md:98`;
  `phases/P08.md:29-39`).
- **Severity:** P1 data isolation / repository-contract breach.
- **Consequence:** A conforming implementation can place tables in `public`, use an unscoped repository in a
  background path, or authorize an opaque CAS reference without verifying its workspace. GraphQL checks would
  not protect scheduler/reconcile/restore paths. A leaked artifact ID or incorrectly scoped job could expose
  another workspace's prompt, evidence, source diff, or permit data before the late S59 isolation work.
- **Smallest corrective action:** Make S03 own an explicit `aria` schema and migration-runner/ schema-drift
  contract with no `public` tables. Define the authoritative tenant-to-workspace-to- repository relation;
  require non-null immutable ownership on every tenant/workspace record, composite foreign keys/unique
  constraints, `getScopedRepository()` (or an equally structural scoped port), and workspace-scoped opaque
  artifact references. Add S03/S04/S08 cross-workspace substitution tests for commands, jobs, effects,
  inbox/outbox, projections, artifacts, deletion, restore, scheduler, and reconciliation. Align
  `ARIA-AUDIT-072` ownership with those tests.
- **Checks:** Schema invariant must fail an `aria-service` entity without `schema: "aria"`, any `public`
  table, or an unscoped repository. A two-workspace integration matrix must prove every
  read/write/background/CAS path denies swapped workspace, tenant, artifact, and cursor IDs.

### DATA-P1-002 — Pre-provider-call DLP is an objective without an executable deliverable or deny proof

- **Evidence:** The broker request contains workspace, snapshot, budget, timeout, retention class, and tools,
  but no admitted prompt/context digest or DLP decision
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:166-173`). S14 says DLP in its
  objective, yet its deliverables and negative controls cover cost, retention source, capability, and provider
  claims only; its finding list omits both DLP findings 022 and 085
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P02.md:65-75`). S23 is a later
  artifact-admission sprint, after the S20/S21 provider brokers, and therefore cannot prevent a sensitive
  outbound prompt (`phases/P03.md:41-87`). The risk register assigns provider secret/prompt/artifact leakage
  only to S23/S39 (`PLAN.md:292`).
- **Severity:** P1 confidentiality / trust-boundary escape.
- **Consequence:** “Raw prompt retention = 0” controls storage, not disclosure. Repository text, conversation
  context, tool output, or a composed prompt containing secrets/PII can reach a CLI provider before any
  documented deterministic DLP grant exists. Every S14, S20, and S21 exit can pass because none proves that a
  DLP denial prevents the network/process call.
- **Smallest corrective action:** Make S14 produce a closed, policy-versioned pre-call admission record bound
  to the canonical full provider payload (system/user messages, repository context, tool inputs, attachments,
  and metadata). Require S20/S21 to consume it before process/network dispatch. Define normalization/decoding
  limits and deny/redact behavior for quoting, multiline, URL/hex/base64, Unicode confusables/normalization,
  binary/archive content, and high-entropy or opaque input; verify provider-side retention/telemetry
  capability rather than treating local zero retention as equivalent. Add 022/085 and matching acceptance IDs
  to S14 where applicable.
- **Checks:** For every secret/PII/encoding fixture, assert broker process spawn and network call count remain
  zero on denial; payload/digest substitution after admission must fail. Positive and false-positive corpora
  must use the same canonical payload builder as production.

### DATA-P1-003 — Rejected quarantine content can enter object versions and backups before DLP passes

- **Evidence:** The design uploads bytes to a quarantine namespace first and only then performs
  digest/size/DLP admission
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:157-164`). S23 likewise makes
  “Quarantine CAS” the delivery path (`phases/P03.md:77-87`). The DR design then uses a versioned object store
  and encrypted off-host backup without excluding quarantine, defining its TTL, or separating its encryption
  key (`design.md:249-258`). S61 tests missing, corrupt, and partial restores, but never proves that
  rejected/quarantined objects and prior versions are absent from replication/backup (`phases/P08.md:53-63`).
- **Severity:** P1 secret/PII retention and backup leakage.
- **Consequence:** A secret-bearing artifact rejected by DLP, or left after a crash between upload and
  admission, may persist in object version history and off-host backups. It can outlive the claimed zero
  raw-prompt policy and the 7-day incident cap even though the visible DB reference was never admitted and
  garbage collection later removes the current object.
- **Smallest corrective action:** Specify quarantine as non-versioned, non-replicated, non-backed-up,
  scanner-only storage with a bounded crash-safe TTL and a job-scoped encryption key destroyed on deny/expiry.
  Alternatively scan before durable upload. Promotion must copy/re-key only admitted bytes into the versioned
  CAS; deletion must cover all versions and multipart/temp fragments. Bind this to S23, S39, S45, and S61.
- **Checks:** Inject deny/crash at every upload/admission boundary, then enumerate current objects, versions,
  multipart fragments, replication targets, backup manifests, and restored regions. No rejected plaintext or
  decryptable ciphertext may survive; admitted object digest and metadata must still reconcile exactly.

### DATA-P1-004 — Encryption-at-rest and data-key custody are absent for primary state and artifacts

- **Evidence:** The state model stores artifacts, DLP/retention metadata, conversations, evidence, incidents,
  and durable decisions in Postgres/CAS but specifies no primary-data encryption or key hierarchy
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:127-137`). The runtime matrix
  identifies a signing-key handle for the attestor, while OP-03 names PKI/KMS for identity/attestation
  bindings; neither assigns data-encryption keys or decrypt capability (`design.md:79-88`;
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:71-78`). Only off-host backup is explicitly
  encrypted (`design.md:255`), and S61's generic “key/config restore” has no key-owner, separation, rotation,
  revocation, or cross-workspace negative (`phases/P08.md:53-63`).
- **Severity:** P1 confidentiality / key-custody boundary.
- **Consequence:** Disk, snapshot, object-store, DBA, backup, or compromised-runtime access can expose
  prompts, conversations, source artifacts, PII, and evidence. One broad key or ambient decrypt permission
  could collapse workspace isolation; key loss/rotation can also make deletion proof or DR irreconcilable.
- **Smallest corrective action:** Add an operator-owned data-key contract distinct from signing, mTLS, and
  provider credentials: TLS in transit, encrypted Postgres/object/version/quarantine/ backup storage, envelope
  keys scoped at least by environment/workspace/data class, KMS/HSM custody, least-privilege decrypt
  identities, audited use, rotation/revocation, backup-key escrow, and crypto-erasure semantics. Assign
  implementation to S03/S18/S23 and live rotation/restore to S41/S61/S68 under explicit OP-03/OP-04 ownership.
- **Checks:** Test wrong-workspace key, compromised single role, revoked/rotated key, lost key, restored old
  backup, ciphertext substitution, KMS outage, and plaintext snapshot/object search. Restore must not open
  effects until keys and exact object/state digests reconcile.

### DATA-P1-005 — Evidence can retain secrets/PII for years without a field-level redaction contract

- **Evidence:** Every evidence record must retain exact commands/workflows and artifact URIs
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:184-189`;
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:44-47`), while decisions, permits, merges,
  and outcomes are retained for three years (`design.md:230-239`). The design forbids PII/ secrets only in
  structured logs and sanitizes provider response artifacts; it does not define redacted
  command/env/URI/stdout/stderr/reviewer-report fields, canonical redaction timing, or admission failure on
  redaction error (`design.md:168-173`, `design.md:230-239`). S39's generic `secret/PII` negative does not
  enumerate evidence surfaces (`phases/P05.md:77-87`).
- **Severity:** P1 long-lived evidence confidentiality.
- **Consequence:** A token in argv/env assignment, a credential-bearing URI, source excerpt, tool output,
  provider trace, or reviewer report can become immutable proof and survive for three years. Later log masking
  cannot remove it, and a digest of the record will faithfully preserve the leak rather than prove safe
  redaction.
- **Smallest corrective action:** Define a typed admitted-evidence schema that stores command ID plus redacted
  argv, allowlisted env names (never values), sanitized artifact identifiers, bounded output summaries, and
  redacted reviewer/incident references. Redaction/DLP must happen before signing, hashing, persistence,
  export, or logging; failure blocks evidence admission. Keep any necessary raw incident material in the
  separately authorized capture vault, never in evidence.
- **Checks:** Seed secrets/PII in argv, env, URI userinfo/query, filenames, stdout/stderr, stack traces,
  provider transcripts, source patches, and reviewer text. Byte-scan every admitted DB row, object/version,
  event, export, backup, and UI response; mutation of any redactor must fail S39/S40.

### DATA-P1-006 — Raw incident capture, legal hold, and deletion lack typed authority and a durable protocol

- **Evidence:** Raw incident capture is enabled by an unspecified “explicit operator decision” for up to seven
  days; legal hold stops deletion, and deletion is described as a DB tombstone, object purge, backup expiry,
  and digest proof (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:230-239`).
  OP-08 only says Privacy/Legal approves retention, capture, hold, and deletion proof (`PLAN.md:78`). S39
  names these outputs but has no capture principal/grant, purpose/legal-basis or consent record, scope,
  revocation, access audit, hold precedence/race, derived-copy inventory, or deletion state machine in its
  tests (`phases/P05.md:77-87`). The `ARIA-AUDIT-064` row tests missing sources and legal hold, but does not
  supply those authority semantics (`FINDING-COVERAGE.md:90`).
- **Severity:** P1 privacy authority / deletion correctness.
- **Consequence:** Any vaguely “operator” identity could enable capture for an excessive workspace, provider
  transcript, or time window, and readers could access raw PII without an auditable need. Concurrent
  hold/delete, retries, projections, object versions, exports, provider-held copies, or backups may leave data
  behind while a digest-bound proof claims completion; conversely, deletion can violate a valid hold.
- **Smallest corrective action:** Define a protected capture/hold/delete authority schema with issuer,
  subject/workspace, purpose, incident/case ID, data classes, consent or documented legal basis, scope, TTL,
  audience, policy version, step-up, and atomic single-use activation. Add durable
  `REQUESTED -> BLOCKED_BY_HOLD | IN_PROGRESS -> VERIFYING -> PROVEN | FAILED` deletion effects with
  outbox/reconciliation across DB rows, projections, CAS versions/fragments, exports, logs, provider
  deletion/retention attestations, replicas, and backup-expiry manifests. Hold creation/ release must be
  independently authorized and race-safe; proofs must list every expected surface.
- **Checks:** Exercise unauthorized/overbroad capture, missing consent/legal basis, TTL expiry, reader
  revocation, capture-disable race, hold-before/during-delete, release/retry, missing surface, provider
  refusal, backup not yet expired, and restore-after-delete. No terminal proof may be emitted until every
  required surface is deleted or explicitly retained under an active hold.

### DATA-P2-007 — `ARIA-AUDIT-023` claims an S67 owner that neither lists nor tests SSRF

- **Evidence:** The 023 matrix row assigns S23 and S67 with `ACC-S23` and `ACC-S67`
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:49`). S67's finding list
  includes 013-020, 024, 045, 079, and 085—not 023—and its negatives are role compromise, below-quorum
  collusion, replay, and verifier outage, not DNS/IP/redirect behavior
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P09.md:29-39`). A full expansion of all 88
  matrix owner ranges against card finding lists found exactly two mismatches: 015/S68 and this 023/S67
  mismatch.
- **Severity:** P2 finding coverage / phase ownership.
- **Consequence:** S38's future machine-readable program cannot decide whether S67 is required to close SSRF
  prevention. One projection can require `ACC-S67`; a card-derived projection can mark the phase complete
  without running an SSRF test.
- **Smallest corrective action:** If S23 is the complete SSRF owner, remove S67 and `ACC-S67` from row 023. If
  compromise-time SSRF is intentionally required, add 023 to S67 and add a live malicious-DNS/redirect/proxy
  test bound to the S67 acceptance.
- **Checks:** Expand every matrix owner and acceptance range and compare it with each sprint card's finding
  list. The result must have zero missing/extra owners; the 023 test must exercise IPv4, IPv6, encoded host,
  rebinding, redirect-to-private, size, timeout, and the actually connected peer address.

## Verified controls and review checks

- Frozen audit worktree HEAD is exact `85787e610e26c192c898ffebd4e51ded856cd880`. `FINDING-COVERAGE.md`
  contains exact unique 001-088 rows; all 88 severity/title pairs match the frozen report byte-for-byte. The
  highlighted 022/023/064/072/085 data/privacy controls were inspected individually.
- Exact S01-S72 and nine phase cards are present. Owner/acceptance expansion reproduces the known 015/S68
  mismatch; owner-to-card expansion additionally identifies 023/S67. No other owner-to-card mismatch was
  found.
- The Postgres protocol explicitly keeps command state, idempotency, effect intent, audit, and outbox in one
  transaction; dispatch is at-least-once with durable inbox dedupe; object admission is quarantine ->
  digest/size/DLP -> DB visibility, and missing objects fail closed (`design.md:157-164`). These controls are
  coherent apart from the quarantine-retention gap above.
- SSRF substance is strong at D0 granularity: HTTPS/egress allowlisting, DNS/IP/private/link-local/ loopback
  checks, IPv4/IPv6/encoded-host fixtures, rebinding, every redirect hop, and size/time bounds are specified
  (`FINDING-COVERAGE.md:49`; `design.md:175-182`; `phases/P03.md:77-87`).
- Read root `CLAUDE.md`, the adversarial brief, complete task contract/report, all changed artifacts, all 88
  rows, and relevant frozen audit sections. The supplied 2,203-line review package's diff payload exactly
  matches `git diff -U10` for the recorded base/head.
- `git diff --check eeb401131..c6065d6da` passed. Protected legacy ARIA/workflow path diff is empty. D0
  remains `VERIFYING`, independent review/admission is pending, and no live/merge/replacement authority is
  claimed.
