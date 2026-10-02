# ADR-0020 — Operator Request Signatures: ed25519 via ssh-keygen, Verified Against a Committed Allowed-Signers File

**Status:** accepted
**Date:** 2026-10-02
**Resolves:** architectural-arbiter rulings I2, I7, I8 (2026-10-02)
**Finding reference:** docs/reviews/claude/2026-10-02-aria-operator-channel.md#ARIA-CRITICAL-255
**Supersedes:** the HMAC re-verification of operator REQUEST rows in
docs/aria/v3-v9-5-safety-contracts-policy.md §12 (kernel-written row kinds keep their HMAC)

## Context

Check 12 (`operator_feedback_signature`) signed every row of `aria-tools/operator-feedback.jsonl`
with a keyed HMAC under `aria-tools/secrets/operator-feedback-hmac.key`, a key the kernel minted on
first use on the runner. For request rows, which carry operator authority at priority 0, that was
the wrong custody on three counts:

1. Any process running as the runner uid could sign with it, so the signature attested "the
   runner wrote this", not "the operator asked for this".
2. The key was never published with the `aria/state` store and the self-hosted lanes'
   `git clean -ffdx` swept it at every job start (`aria-auto-cycle.yml`, `aria-agent-executor.yml`),
   so no later job could verify a row.
3. The pre-merge perimeter runs on GitHub-hosted runners (`aria-merge-authority.yml`) that never held
   it, so an operator-sourced plan could never merge.

## Decision

- **The operator signs.** A request row is signed with an ed25519 key the operator holds off-runner,
  through `ssh-keygen -Y sign -n aria-operator-request`. The kernel passes the operator-supplied key
  path (`feedback request --signing-key`) to ssh-keygen and never reads, copies or stores it.
- **The trust anchor is committed.** `.github/manifests/aria-operator-signers` (ssh allowed_signers
  format, `principal namespaces="aria-operator-request" keytype key`) is read as a git object at a
  named commit, never from the working tree: the cycle checkout's HEAD at ingestion, the PR's live
  base on `main` at merge (so a principal revoked on `main` cannot merge what it asked for).
  `.github/` is in `implementation_safety.READONLY_PATHS`, so ARIA cannot enrol a key; enrolment and
  rotation are reviewed pull requests.
- **The signed subject** is `aria-operator-request/v1\n` + canonical JSON of the row minus
  `signature`, `ledger_hash` and `previous_ledger_hash` (the principal and `schema_version` are
  signed), mirroring `canonical_signing_bytes` with a distinct domain tag.
- **Verification** is `ssh-keygen -Y verify` with `-f <allowed> -I <principal>`, the request
  namespace and `-s <sig>`, the subject on stdin, bounded by a timeout. A missing ssh-keygen, a
  missing anchor, a timeout, an unenrolled principal and a bad signature are each a named refusal
  (`operator_request_signature.VERIFICATION_REASONS`), never a pass.
- **HMAC stays only for kernel-written row kinds** (verdict rows from `feedback_store`, calibration
  fixtures). They are never plan candidates; the HMAC append path refuses a request-shaped row.
- **Check 12 on GitHub-hosted lanes** walks plan → binding → ingestion → consumed rows as before
  (chain pins unchanged) and re-verifies each consumed request against the committed anchor. No key
  file is read or needed.

## Consequences

- No operator signing material exists anywhere a runner uid can read; a compromised runner can
  append rows but cannot make one verify.
- Every lane — self-hosted cycle, GitHub-hosted merge — verifies with the same committed file.
- Rotation is a pull request that edits the allowed-signers file; during rotation both keys may be
  enrolled. Removing a principal on `main` stops in-flight plans from its requests at merge.
- The losing side: recording a request needs the operator's key at hand (or in ssh-agent) and a
  checkout whose HEAD carries the anchor; a request cannot be filed from a runner.
