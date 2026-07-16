# INFRA-CRITICAL-044 protected SSH broker substrate review

- Date: 2026-07-16
- Owner: infra-expert
- Deadline: 2026-07-18
- Canonical finding: `docs/reviews/_registry/findings.jsonl#INFRA-CRITICAL-044`
- State: OPEN — production remains locked; substrate is pre-cutover

This review records the reproduced closure blockers found while implementing the
attestation-only backup SSH broker. They are part of the existing
`INFRA-CRITICAL-044` execution-boundary finding rather than separate registry
rows: none has value outside the broker's release, installation, or live
attestation closure.

## Reproduced closure blockers

1. A signed release could be selected while merely being an ancestor of the
   attestation commit. Without byte parity against current protected `main`, an
   older vulnerable broker, build script, provisioner, policy, or release
   workflow could be replayed during the artifact-retention window.
2. The live workflow proved the diagonal key, off-diagonal key denial, and
   unrecognized-command denial, but did not actively request an interactive shell, PTY,
   subsystem, remote forwarding, or direct-stream forwarding.
3. `ci-affected.yml` could return successful required summaries with
   `has_changes=false` for broker source, the provisioner, and broker workflow
   changes. A signed release authority must not treat no-op summaries as a
   substantive validation of its own trust boundary.
4. Required check selection did not bind check completion time to the PR merge
   time. A post-merge rerun could therefore be mistaken for pre-merge branch
   protection evidence.
5. The referenced `production-backup-release` GitHub Environment did not exist.
   If the workflow reached `main` first, GitHub could create an unprotected
   Environment instead of enforcing the intended reviewer separation.
6. The target provisioner invoked `cmp` after mutation without declaring it in
   the preflight command inventory. A minimal target could therefore enter the
   rollback path for a missing dependency instead of failing before mutation.
7. A plain Bash shebang allowed `BASH_ENV` and exported shell functions to load
   before the provisioner could sanitize its environment. On a root invocation,
   the body-level `unset` was therefore too late to protect the trust boundary.
8. The effective sshd contract did not pin `ForceCommand none`. A pre-existing
   global `ForceCommand internal-sftp` could bypass the account login shell and
   turn an attestation-only principal into a file-transfer principal.
9. The account checks proved a private group name but not numeric GID
   uniqueness across local group and passwd authorities. A duplicate numeric
   GID could make the claimed single-group boundary ambiguous.
10. The effective policy also omitted `ChrootDirectory none`. A pre-existing
    chroot could replace the account's expected filesystem view and invalidate
    the broker's direct `/etc/passwd`, shell-path, and executable authorities.
11. Existing authorized-key paths were replaced before the final sshd reload.
    Rollback restored the old state after failure, but a concurrent connection
    could observe a newly staged key during the mutation window.
12. The public fixed command was serialized as `token`. Besides misstating the
    authority model, that label caused the default `generic-api-key` detector
    to classify the public command as a credential. The active protocol now
    calls it `command`, preserving future detection without a path or regex
    allowlist. Because the pushed commit is immutable, two exact
    commit/path/rule/line fingerprints quarantine only that historical false
    positive; a repeated credential-shaped field receives a new fingerprint
    and fails the scan.

## Live control-plane state after stop-line repair

At `2026-07-16T18:46:26Z`, `production-backup-release` exists with an exact
`main` branch policy, `can_admins_bypass=false`, `prevent_self_review=true`, and
zero secrets or variables. The repository has only one direct collaborator,
`Okan-wqm`, who is also the configured reviewer. Consequently the signing job
is deliberately fail-closed until an independent reviewer or team is added;
the controls were not weakened to manufacture a releasable state.

The existing `production-backup` Environment is also exact-`main` but still has
zero secrets and zero variables. The host, pinned host-key fingerprint, three
operation private keys, and three public-key fingerprint variables therefore
remain intentionally absent; all live broker-attestation jobs are unrunnable
until the target install and independent key ceremony occur.

## Disposable real-OpenSSH validation

At `2026-07-16T20:03:00Z`, the current provisioner and static broker passed a
network-isolated disposable-container harness using real OpenSSH 9.6p1. The
container mounted the repository read-only and changed neither the live host nor
the repository. The run proved:

- three exact diagonal JSON attestations, six off-diagonal key/account denials,
  three arbitrary-command denials, and fifteen interactive-shell, PTY,
  subsystem, remote-forward, and direct-stream denials;
- exact rerun state/output idempotency with a sanitized reload environment,
  plus a real old-key login denied while the separately reloaded maintenance
  barrier was active;
- exact rollback on a controlled final-activation reload failure, including a
  second in-window login denial, old-key continuity after rollback, and new-key
  rejection; and
- direct-local account authority under both NSS masking and non-local collision
  injection, with collision rejection before target residue.

The tested source SHA-256 was
`521254074489c5d70df3b6ee054a4de3b4c534530e4e0575c06245758855735e`; the
static broker binary SHA-256 was
`2663cd902976e10d7a6d5fa68459afb572677d79b094a56c74eb7975a0d462fb`.
This is substrate validation only and is not production-host or independent DR
evidence.

## Required evidence before cutover

- The signed bundle contains the release workflow and every executable policy
  material; the verifier compares each byte-for-byte with current protected
  `main`.
- Required checks are successful on the exact merged PR head and completed no
  later than the immutable merge timestamp.
- Every broker/control-plane path triggers substantive required-check jobs.
- Live negative requests cover interactive shell, PTY, subsystem, remote
  forwarding, and direct-stream forwarding in addition to the key/command
  matrix.
- Every external provisioner command is present before input snapshots or
  target mutation begin.
- The provisioner starts only in Bash privileged mode, which ignores `BASH_ENV`
  and inherited shell functions before its first body instruction.
- Effective sshd policy pins `ForceCommand none` and `ChrootDirectory none`, and
  each account's numeric UID and private GID remain unique in the direct local
  authorities both before and after mutation.
- A separately reloaded `DenyUsers` maintenance barrier closes all three login
  principals before any active path changes; only the final validated reload
  removes that barrier.
- The active attestation schema represents the public forced command as
  `command`; scanner quarantine is limited to the two immutable historical
  fingerprints and cannot mask a future occurrence.
- `production-backup-release` exists before merge, permits only `main`, and has
  at least two eligible required reviewers. It holds no secrets or variables.
- Real-target systemd reload, root-owned installation, host-key-bound three-key
  attestation, three successive backups, and timestamp PITR remain outstanding
  operational acceptance evidence.
