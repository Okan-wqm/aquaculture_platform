# D0 adversarial review — identity and trust boundaries

## Verdict

`CHANGES_REQUIRED`

No P0 was found. Six P1 identity/trust-boundary defects remain, so D0 cannot be approved. The
legacy protected surfaces have zero diff, D0 remains `VERIFYING`, and the separate-worker failure
domain is explicitly planned; those controls do not cure the gaps below.

## Findings

### P1-001 — The immutable human subject is named but never canonically defined

- **Evidence:** The access rule binds authorization to an `immutable-subject` but does not define
  its issuer, audience, canonical form, or authoritative role/module source
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:97`). S04 only asks
  for an identity registry and rejects mutable login/tenant-header input; it has no same-`sub`
  cross-issuer, account rebind, stale allowlist, or revoked-subject case
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:43`).
- **Consequence:** An implementation can key the allowlist on a bare `sub`, username, or mutable
  account mapping and still satisfy the card. Subject collision or reassignment can then inherit a
  workspace allowlist and mint workspace-bound step-up authority for the wrong person.
- **Smallest corrective action:** Define the canonical subject as a server-verified identity tuple
  (including trusted issuer, audience and immutable subject ID), define where `SUPER_ADMIN` and
  `ModuleCode.ARIA` are authoritatively resolved, version the subject-to-workspace binding, and add
  issuer collision, login/email rename, subject rebind, revocation and stale-binding negative tests
  to S04/S08.

### P1-002 — Repository/workspace identity has competing remote-derived and provider-ID contracts

- **Evidence:** S09 makes “remote normalization” and fork/namespace identity its deliverables
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P02.md:8`), and S59 again names a
  “canonical remote” (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P08.md:32`). The
  finding authority instead says the primary identity is the immutable provider repository ID and
  that URL is not identity (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:77`).
  The design never resolves that distinction into a canonical schema.
- **Consequence:** A remote rename/transfer, attacker-controlled local remote, mirror, or fork can
  split one workspace or collide two workspaces. Evidence, artifacts, grants and permits bound to
  the resulting `workspaceId` can then be replayed or attached across repositories.
- **Smallest corrective action:** Make the identity schema authoritative in the design and S09:
  provider/host plus immutable provider repository ID is primary; normalized URLs and remote names
  are metadata only; fork lineage and operator-issued workspace ID are separate typed fields. Add
  rename, transfer, mirror, local-remote spoof, delete/recreate, same-repo clone, fork and
  cross-provider collision tests, then require S59 to reuse the same resolver rather than define a
  second one.

### P1-003 — Worker authentication and runner attestation have two unbound trust roots

- **Evidence:** The runtime design identifies the executor by worker mTLS CN
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:85`), while the
  frozen-finding mapping requires externally verified OIDC or a pinned worker identity
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:42`). S18 only says
  “mTLS identity” and “external attested identity” without defining how the certificate, VM, UID,
  attestation and job capability are bound
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md:19`).
- **Consequence:** A worker can authenticate through one channel while presenting producer-chosen
  claims from the other. The wrong VM/UID or a replayed runner attestation can be accepted without
  being cryptographically tied to the live session and job, falsely closing `ARIA-AUDIT-016`.
- **Smallest corrective action:** Choose and document one canonical workload identity chain. Bind
  the operator-PKI certificate identity/key fingerprint to the pinned VM/workload attestation,
  runtime UID, worker registry record, nonce, job ID and expiry; treat declared claims as
  non-authoritative. Add channel-substitution, cert/attestation mismatch, cloned VM, stale
  attestation and cross-job replay negatives to S18/S27.

### P1-004 — Eight-role UID/secret/network separation is asserted but has no complete acceptance owner

- **Evidence:** The fixed contract requires distinct identities, UIDs, secrets, network policies
  and capability sets for all eight roles (`.superpowers/sdd/BOOTSTRAP/task-1-brief.md:79`). The
  design repeats the assertion (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:90`),
  but S18 verifies only the executor (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md:19`).
  The deployment sprint asks for generic runtime manifests and checks legacy sharing/any write,
  not all-role UID, secret-mount, egress and Linux-capability collisions
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P06.md:7`).
- **Consequence:** Two broker/control/attestor/GitHub roles may share a UID, filesystem, ambient CLI
  session, secret mount or network capability while every named sprint exit still passes. A
  single-role compromise can then cross into provider, attestation, publish or merge authority.
- **Smallest corrective action:** Assign an eight-role runtime/capability manifest to a specific
  pre-live sprint and make it part of P03/P04/P06 gates. Add machine-checked pairwise uniqueness and
  absence tests for UID, workload identity, filesystem, secret mounts, provider sessions, GitHub
  credentials, egress, Linux capabilities and scheduling placement; include rotation/revocation
  owners for every secret class.

### P1-005 — The cert-only NATS rule has no sprint deliverable or negative control

- **Evidence:** Cert-only CN identity and absence of CONNECT user/password/token are design rules
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:92`) and a PLAN hard
  constraint (`docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:21`). None of the P01-P09
  sprint cards names NATS, `infrastructure/nats/services.yaml`, certificate minting, generated
  configuration, or the repository NATS invariant. S02's scaffold exit is only health/dependency
  isolation (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:19`).
- **Consequence:** A later adapter can introduce NATS with token/user-password identity or omit the
  cert-CN SSoT registration while all 72 documented exits remain satisfiable. The statement is
  therefore not an executable phase control and violates the repository's cert-is-identity rule.
- **Smallest corrective action:** Either make “no NATS dependency” an enforced architecture
  invariant, or assign NATS use to a sprint that atomically updates `infrastructure/nats/services.yaml`,
  mints the exact CN, regenerates config, verifies no CONNECT credential fields, runs the existing
  NATS invariant, and proves broker loss cannot lose durable command/effect truth. Add that proof to
  the owning phase gate.

### P1-006 — Publisher-versus-merge GitHub identity proof can pass for the wrong reason

- **Evidence:** OP-01 asks only for separate Apps, a permission manifest and branch-protection
  export (`docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:71`). S25 says the Publisher
  cannot obtain a merge credential (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P04.md:15`),
  and S26 probes that Publisher cannot access the merge endpoint
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P04.md:27`). Neither binds App ID,
  installation ID, repository ID and base-branch ruleset into the action envelope, nor requires the
  Publisher denial probe to use an otherwise merge-eligible PR.
- **Consequence:** The Publisher probe can be denied because checks, reviews or branch conditions
  are incomplete even though the credential can merge once those conditions are met. The claimed
  principal separation then disappears exactly at the promotion point.
- **Smallest corrective action:** Pin Publisher/Merge App IDs, installation IDs, repository IDs,
  permissions and base-branch ruleset digest in operator-owned TCB. Test the same otherwise
  merge-eligible PR with each identity: Publisher must be provider-denied, Merge App must still have
  no bypass, and only a consumed exact permit may authorize its request. Include wrong-installation,
  repository-transfer, token rotation/revocation and stale-ruleset negatives.

### P2-007 — The authority index and OP-03 dependency graph disagree with detailed cards

- **Evidence:** OP-03's Gate column lists only S04/S05/S28
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:73`). The authoritative index omits
  OP-03 from S18 and S27 (`docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:151`,
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:167`), while their detailed cards
  require it (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md:24`,
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P04.md:36`). S67 has the same detail/index
  mismatch (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P09.md:36`,
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:242`).
- **Consequence:** Operators and automation consuming the required complete index see a different
  readiness graph from the sprint authorities. The existing transitive S04 dependency limits the
  immediate bypass, but the program fails its exact-dependency SSoT contract and can drift later.
- **Smallest corrective action:** Synchronize OP-03's Gate column and the S18/S27/S67 index rows
  with their cards, then add a machine check that expands ranges and compares every card dependency
  against the PLAN index and operator-prerequisite reverse index.

## Checks performed

- Read root `CLAUDE.md`, the D0 brief, task contract, implementer report, full changed artifact set,
  diff package, and relevant frozen audit sections.
- `git rev-parse HEAD` -> `c6065d6dac97306f147de67ef58a96e3a67524ac`.
- `git diff --check eeb401131260fe45f3f60be55fa25d023a082d18..c6065d6dac97306f147de67ef58a96e3a67524ac`
  -> exit 0.
- Protected legacy-path diff over the reviewed range -> empty.
- NATS phase-coverage search -> design/PLAN assertions only; no P01-P09 sprint-card owner.
- Confirmed D0 remains `VERIFYING`, independent review/admission is pending, and no artifact claims
  live or merge authorization.
