# Codex sandbox `/dev/null` git-status blocker

Date: 2026-05-02

## Problem

Inside the Codex sandbox, `git status --short` fails with:

```text
fatal: could not open '/dev/null' for reading and writing: Permission denied
```

The same command succeeds when executed outside the sandbox with elevated
permissions. `/dev/null` reports the expected device metadata
(`crw-rw-rw-`, major/minor `1:3`), so this is not a repository-level defect and
does not indicate that the repo's Git metadata is corrupt.

## Impact

Normal sandboxed git status/diff commands cannot be trusted for this session.
This blocks safe commit preparation unless git visibility is obtained through a
normal shell or an approved elevated command.

## Root Cause Direction

The evidence points to a Codex sandbox/device access policy issue, not a host
filesystem permission issue. Do not apply repo patches, chmod, or recreate
`/dev/null` as a workaround.

## Enterprise Fix Direction

- Treat sandboxed git visibility as unavailable for this session.
- Use an approved non-sandbox shell/elevated git command for status/diff only.
- Before commit or push, require a clean human-readable `git status --short`
  from a normal shell.
- Record this as an environment blocker rather than hiding it with shell tricks.

## Verification

- `git status --short` outside sandbox: passes.
- `git branch --show-current` outside sandbox: current branch is
  `agentic-orphan-012b-pin-deps`.
- Branch currently has no upstream, so newly added workflows cannot run in
  GitHub Actions until the branch is pushed.
