# ADR-0023 — Signature Namespace Registry and Principal Classes

**Status:** accepted (operator, 2026-10-02)
**Date:** 2026-10-02
**Owner:** okan
**Decision deadline:** before kernel step K5 (S1) opens; target 2026-10-09
**Resolves:** architectural-arbiter program-review rulings 3 (the signer anchor is unprotected), 8
(a namespace registry before CJ-0) and 13 (the namespace trust root is an undecided one-way door),
2026-10-02
**Finding references:** ARIA-LOW-267 (closed by S1 under this ADR); ARIA-MEDIUM-273 (the accepted
risk this ADR records); ARIA-HIGH-270 and INFRA-MEDIUM-197 (closed by S1 under this ADR);
ARIA-LOW-269 (narrowed). ARIA-MEDIUM-273, ARIA-HIGH-270 and INFRA-MEDIUM-197 are registered by
PR #1711, not yet on `main` at 44983f55d.
**Extends:** ADR-0020 (`2026-10-02-adr-0020-operator-request-signature-scheme.md`); the request
subject and its verification are unchanged
**Related:** ADR-0022 (journey anchors and label items name node IDs)

## Context

ADR-0020 made the operator sign plan requests with `ssh-keygen -Y sign` under the namespace
`aria-operator-request`, verified against `.github/manifests/aria-operator-signers` read as a git
object at a commit proven on `main` (`aria-kernel/aria_kernel/operator_request_signature.py:44-49`,
`:132-156`, `:234-281`; `aria-kernel/aria_kernel/main_anchor.py:136-181`). That is one namespace
for one act.

The program adds three operator acts: weekly label seals that become calibration ground truth
(F-L2), critical-journey anchors (CJ-1) and changes to the trust anchor itself (arbiter ruling 3).
Two namespaces already carry ARIA's own attestations: state snapshots (`aria-state-snapshot`,
`aria-kernel/aria_kernel/state_snapshot.py:94-98`) and commit signatures by per-cycle keys
(`aria-kernel/aria_kernel/gh_token_factory.py:438`, verified at
`aria-kernel/aria_kernel/implementation_safety.py:334-363`). Nothing records which namespaces
exist, who may sign in each, how long a signature may wait or which code verifies it, and the
request verifier hard-codes its namespace (`operator_request_signature.py:44`, `:221`, `:271`).

Four gaps sit around the anchor:

- **Enrolment.** The allowed-signers file is guarded by CODEOWNERS alone
  (`.github/CODEOWNERS:52`), and `main` requires no review (INFRA-MEDIUM-197). Every root agent
  session on this host acts on GitHub as the operator, so any process holding the host's GitHub
  credentials could enrol its own key through a pull request (ruling 3). `.github/` in
  `READONLY_PATHS` (`implementation_safety.py:76`) keeps ARIA's implementer out, not other writers.
- **Policy.** Request lifetime and audience come from `docs/aria/policy/operators.json`
  (`aria-kernel/aria_kernel/operator_request_terms.py:39-50`, through
  `aria-kernel/aria_kernel/operator_approval.py:56` and `:93-96`), read from the working tree, and
  `docs/aria/policy/` is not in `READONLY_PATHS` (ARIA-LOW-267).
- **Local refs.** The anchor's ancestry check trusts the runner-writable
  `refs/remotes/origin/main` (`main_anchor.py:121-157`; ARIA-LOW-269).
- **The MCP write gate.** `_write_gate` accepts any approval ref of six characters or more
  (`aria-kernel/aria_kernel/mcp_server.py:163-170`; ARIA-HIGH-270).

Three principal classes act on this host (program plan rev2, constraint K-2′):

- **T0**, the operator at an interactive terminal;
- **T1**, a root agent session on the host acting for the operator;
- **T2**, ARIA's runner: `gharunner`, uid 1000 with no supplementary groups (measured 2026-10-02:
  no sudo, not in the docker group), `/root` mode 700, a GitHub App identity, and no personal
  access token in the runner `.env` (`docs/runbooks/aria-runner-rebuild.md:39`).

On 2026-10-02 the operator decided that the signing key stays on the server. The key is root 0600
without an interactive passphrase and is also the commit-signing key (ARIA-MEDIUM-273), so a T1
session can sign exactly what T0 can: **T0 and T1 cannot be told apart cryptographically.** That is
an accepted risk (ARIA-MEDIUM-273, owner okan, deadline 2026-12-31, revisited when the repository
goes private). **What can be enforced is that T2 never signs or approves as the operator**, and
that is the property this ADR builds on.

## Decision

### One committed registry

`.github/manifests/aria-signature-namespaces.json` (schema `aria/signature-namespaces/v1`) is the
only list of `ssh-keygen -Y` namespaces ARIA signs or verifies. The kernel reads it as a git object
at the anchor commit, through the same hardened reader as the allowed-signers file. A namespace that
is not in it verifies nothing. Each entry records:

- the namespace and its subject domain tag (`<namespace>/v<n>`);
- the subject fields that are signed;
- the principal classes that may sign;
- the expiry bound, in hours;
- the verifier (module and function);
- a status, `active` or `retired`; a retired namespace still verifies history and refuses new
  signatures.

Every operator subject is the domain tag, a newline and the canonical JSON of its fields (sorted
keys, no whitespace, ASCII; `operator_request_signature.py:107-116`). Besides its own fields it
carries `signer_principal`, `audience` (the repository) and `expires_at`, and from S1 on
`actor_class` (`T0` or `T1`): the signer's signed declaration of who is signing. `actor_class` is a
declaration, not a proof (ARIA-MEDIUM-273); it records a delegated act as delegated, which is the
rule that finding sets for anything calibration treats as human ground truth. No operator namespace
admits `T2`, and the registry schema refuses an entry that lists it.

### The four operator namespaces

**`aria-operator-request`** (exists; ADR-0018, ADR-0020)

- Subject: `aria-operator-request/v1` over the request row minus `signature`, `ledger_hash` and
  `previous_ledger_hash` (`operator_request_signature.py:49`, `:53-55`). This ADR does not change
  how those bytes are formed: a new row gains the `actor_class` field, and every request already
  signed keeps verifying.
- Signers: T0 or T1. A T1 request is a delegated operator act (K-2′).
- Expiry: `expires_at` at most 168 hours after signing (ADR-0018, decision 2).
- Verifier: `operator_request_signature.verify_operator_request` (`:234-281`), against
  `allowed_signers_for_checkout` (`:145-156`) at ingestion and `allowed_signers_at` (`:132-142`)
  at the pull request's base at merge (`aria-kernel/aria_kernel/merge_authority.py:1249-1251`).

**`aria-operator-label`** (F-L2)

- Subject: `aria-operator-label/v1` over the round (`YYYY-Www`), `batch_digest` (sha256 of the
  canonical label table: item, subject node IDs, verdict, inclusion probability) and `item_count`;
  from A4 on it also carries the memory Merkle head, so the weekly seal signs memory too (ruling
  12).
- Signers: T0 only, by procedure: only the operator's interactive `seal-round` signs, it refuses a
  key loaded in ssh-agent (program design F), and the verifier refuses `actor_class` T1. A T1
  signature still verifies cryptographically; that is ARIA-MEDIUM-273.
- Expiry: ingested within 168 hours of signing; a round is one week.
- Verifier: the S1 namespace verifier, called by `feedback_store record-batch --seal` (F-L2).

**`aria-operator-journey`** (CJ-1)

- Subject: `aria-operator-journey/v1` over `path` (`packs/software-repo/critical-journeys.json`),
  `content_digest`, `parent_digest` (the previous signed version's digest, or `genesis`) and
  `anchors` (sorted ADR-0022 node IDs). The signature is a detached `.sig` beside the file.
- Signers: T0 or T1. Claude drafts the journey list for the operator, and plan rev2 Faz 3 names a
  T1 signature for CJ-1.
- Expiry: at most 168 hours between signing and the merge that commits it, checked before merge. A
  committed version stays valid until a successor names it as its parent.
- Verifier: the S1 namespace verifier; every anchor must parse as an ADR-0022 node ID.

**`aria-operator-enrol`** (S1)

- Subject: `aria-operator-enrol/v1` over the `parent` and `child` digests of the allowed-signers
  file and of this registry, plus the child files' bytes.
- Signers: T0 only, by procedure, as for labels: an enrolment changes who may sign everything else.
- Expiry: at most 168 hours between signing and merge, checked before merge. A merged enrolment is
  history and is not re-checked.
- Verifier: the S1 chain verifier below, run on every anchor read.

### ARIA's own namespaces

Two namespaces carry T2 attestations. They are registered so the list is complete, and they never
carry operator authority:

- `aria-state-snapshot`: signed with the cycle key (`state_snapshot.py:522`), verified against an
  operator-pinned trust store (`state_snapshot.py:607-668`);
- `git`: commit signatures by per-cycle keys (`gh_token_factory.py:438`), verified with a
  kernel-built allowed-signers file (`implementation_safety.py:334-363`).

No key T2 holds is ever enrolled in the operator allowed-signers file.

### The enrolment chain (ruling 3)

- **A change verifies only through its parent.** The allowed-signers file and the registry change
  only together with an enrolment row signed in `aria-operator-enrol` by a key that the PARENT
  version enrols for that namespace. A key a change adds cannot sign its own enrolment.
- **The rows carry the chain.** Rows are appended to
  `.github/manifests/aria-operator-enrolments.jsonl`. Each carries the child files' bytes, so the
  chain verifies from one commit's tree, on a shallow clone too, without walking history and
  without trusting local refs.
- **The genesis is pinned.** The pair as S1 commits it (the allowed-signers file with the
  operator key enrolled for the four operator namespaces, and the first registry) is pinned by
  digest in `aria_kernel/`, which is read-only to ARIA (`implementation_safety.py:75`). Today's
  file (blob f1ce80db3 at 44983f55d, added in 3f056f052) enrols the key for
  `aria-operator-request` alone.
- **Every anchor read walks it.** Start at the pinned genesis. For each row, its parent digests
  must equal the current state, its signature must verify in `aria-operator-enrol` against the
  current allowed-signers bytes, and its child bytes must hash to its child digests. The end state
  must equal the allowed-signers file and the registry committed at the anchor commit. A break is a
  named refusal (`enrol_genesis_mismatch`, `enrol_chain_broken`, `enrol_signature_invalid`,
  `enrol_tip_mismatch`), never a pass, and it leaves the anchor unavailable: a runner fault in the
  sense of `operator_request_signature.py:90-95`, so no request is spent on a broken anchor
  (ADR-0018, decision 6).
- **It is the existing verifier, generalised.** `main_anchor.committed_blob`
  (`main_anchor.py:166-181`) reads all three files at the commit `resolve_main_anchor`
  (`main_anchor.py:136-157`) proved on `main`; `allowed_signers_at`
  (`operator_request_signature.py:132-142`) returns an anchor only after the chain verifies; and
  the ssh-keygen call of `verify_operator_request` (`:258-281`) becomes one namespace-parameterised
  verification whose namespace, domain tag and expiry come from the registry entry. The request
  path calls it with unchanged bytes. CJ-1 and F-L2 add callers, not verifiers.

### What keeps T2 from signing or approving

Custody and the App identity hold today; the other guards arrive with S1.

1. **Custody.** The operator key lives under `/root` (mode 700), root 0600. T2 runs as uid 1000
   with no sudo and no docker group, so it cannot read the key.
2. **Enrolment.** T2 cannot add a key. ARIA's writes to `.github/` are refused today
   (`implementation_safety.py:76`); S1 adds `docs/aria/policy/`, the merge-authority refusal of an
   ARIA-authored pull request that touches either (the INFRA-MEDIUM-197 rule), and the enrolment
   chain, under which only a key the parent version already enrols can sign a change.
3. **Key separation.** No key T2 holds (per-cycle commit keys, the snapshot key) appears in the
   operator allowed-signers file; the S1 probe checks it on every run.
4. **Approval.** T2 posts on GitHub as an App, and `verify_operator_approval` refuses an author
   that is not a User (`operator_approval.py:381-385`); the runner holds no personal access token.
   The open path today is the MCP write gate (ARIA-HIGH-270): S1 makes `_write_gate` accept only a
   signature that verifies in a registered operator namespace.

## Consequences

- **S1 (K5) implements this ADR:** the registry reader, the namespace verifier, the enrolment chain
  and its genesis pin, the T2 separation invariant with an hourly watchdog probe (K-2′), a
  signature-verified `_write_gate` (ARIA-HIGH-270), the merge-authority refusal of an ARIA-authored
  pull request that touches a trust anchor (INFRA-MEDIUM-197), and reading the request terms as git
  objects at the anchor commit instead of from the working tree.
- **CJ-1 and F-L2 use it.** Journey anchors and label seals verify through the S1 verifier and
  bring no verifier of their own. F-L2 is also where the label queue becomes blind and records
  inclusion probabilities (ARIA-MEDIUM-276, registered by PR #1711).
- **`docs/aria/policy/` becomes read-only to ARIA** (ARIA-LOW-267), in the same S1 change as the
  rest of the K-5′ list (`packs/`, `tools/aria-labels/`, `tools/runtime-truth/`,
  `libs/journey-pins/`, `docs/recommendations/**`), which is where signed artifacts and arbiter
  records live.
- **The registry holds the signature expiry bounds.** `operators.json` keeps `repository` and keeps
  `approval_max_age_hours` for GitHub-comment approvals only.
- **ARIA-LOW-269 narrows.** A forged local `origin/main` can no longer introduce a key, because a
  forged chain needs an operator signature. It can still present an older valid chain state; the
  merge lane's fresh clone stays the backstop (ADR-0020).
- **Rotation is two signed acts:** enrol the new key with a signature by the old one, then remove
  the old key with either.
- **The losing side.** Every change to the allowed-signers file or the registry needs an operator
  signature as well as a pull request, and a lost key with no second enrolled key can be recovered
  only by changing the genesis pin, which is an amendment of this ADR.

## Rejected alternatives

- **One namespace for every operator act.** A label seal or an enrolment signed as a request would
  rely on subject shapes never colliding. `ssh-keygen -n` separates domains structurally, and an
  allowed-signers line can restrict a key to named namespaces; a cross-namespace signature is
  already refused (`aria-kernel/tests/test_operator_request_signature.py:109`).
- **Namespaces declared ad hoc in each module**, the way `aria-state-snapshot` was
  (`state_snapshot.py:94-98`). Nothing would say which class may sign what, and a key could be
  enrolled for a new namespace without anyone deciding who holds it.
- **Moving the key off the server** so T0 and T1 separate cryptographically. The operator decided
  on 2026-10-02 to keep it on the server; the decision is recorded as ARIA-MEDIUM-273 and is
  revisited when the repository goes private.
- **Required code-owner review on `.github/manifests/` as the enrolment guard.** With
  `enforce_admins` on it locks the only human code owner out of their own pull requests, an admin
  bypass actor fails readiness (`aria-kernel/aria_kernel/enterprise_readiness.py:622-626`,
  ARIA-HIGH-207), and a review cannot tell the operator from agents acting as the operator on
  GitHub (INFRA-MEDIUM-197).
- **GitHub-comment approvals for the new acts.** Every root agent session on this host posts as the
  operator's login, so a comment proves a GitHub identity, not the operator.
  `verify_operator_approval` stays where it is used today and is not extended to labels, journeys
  or enrolment.
- **An HMAC key held as a GitHub secret.** ADR-0020 rejected it: every job's code could sign with
  it.

## One-way doors

- **Namespace strings and subject domain tags.** A signature verifies only under its namespace and
  its exact subject bytes. Renaming a namespace or editing a subject version invalidates every
  signature made under it, including label seals that calibration counts as ground truth. A
  namespace is retired, never renamed; a new subject shape is a new `/vN` tag.
- **The genesis pin.** It roots every later enrolment. Changing it rewrites trust history and needs
  an amendment of this ADR.

Not a door: the principal-class model. When the key leaves the server (plan rev2, risk R-2), T0
gets its own principal and the label and enrolment entries narrow to it; no existing signature
stops verifying.

## Verification

- **Existing:** `aria-kernel/tests/test_operator_request_signature.py:109` refuses a signature made
  for another namespace; `:148-207` read the anchor from the committed file at a commit on `main`
  and show that replace refs, the git environment and object alternates cannot steer it.
- **Registry invariant (S1):** the registry parses; it lists the four operator namespaces with
  signer classes within T0 and T1 and the two T2 namespaces with T2 alone; every namespace constant
  the kernel exports (`operator_request_signature.SIGNATURE_NAMESPACE`,
  `state_snapshot.SIGNATURE_NAMESPACE` and those S1 adds) is a registry entry; every `namespaces=`
  value in the allowed-signers file is an operator namespace.
- **Enrolment chain (S1):** a change signed by a parent key verifies; a self-enrolment signed by the
  new key is refused; an unsigned change, a genesis mismatch and a tip mismatch are refused; a
  rewritten local `refs/remotes/origin/main` carrying an unsigned enrolment is refused; an expired
  enrolment is refused before merge.
- **Namespaces (S1):** a label seal declaring `actor_class` T1 is refused; a journey version whose
  parent digest is not the committed predecessor is refused; each namespace refuses a subject past
  its expiry bound.
- **Read-only policy (S1):** `docs/aria/policy/` joins the required set pinned in
  `aria-kernel/tests/invariants/v9/test_phase_v9_0_d_implementation_safety.py:224-245`.
- **T2 probe (S1):** run as `gharunner`, it cannot open the operator key path, its uid is not 0, it
  has no sudo, it is not in the docker group, the runner `.env` holds no personal access token, and
  no public key T2 holds appears in the allowed-signers file. It runs as an invariant test and as
  an hourly watchdog probe (K-2′).
- **Write gate (S1):** `_write_gate` refuses an unsigned or wrongly namespaced approval.

## Status of this record

Accepted by the operator on 2026-10-02 after review of the draft, as the header records. Kernel step
K5 (S1) implements it, and CJ-1 and F-L2 build on it. A change to this decision is an amendment: a
new record that names this one. The one-way doors above change only that way.
