# Attestation: `<FINDING-ID>`

| Field                | Value                                         |
| -------------------- | --------------------------------------------- |
| Finding ID           | `<SEVERITY>-<NNN>`                            |
| Severity             | CRITICAL / HIGH                               |
| Opened               | `<YYYY-MM-DD>`                                |
| Resolved             | `<YYYY-MM-DD>`                                |
| Closing commit(s)    | `<short-sha>`, `<short-sha>`                  |
| Attested by          | `<GitHub handle — author>` + `<reviewer>`     |
| Control type         | architectural / process / operational         |
| SOC2 criterion       | CC<x.y> (if applicable)                       |
| KVKK article         | Art <N> (if applicable)                       |
| GDPR article         | Art <N> (if applicable)                       |

## Finding summary

<!-- 1-3 sentences describing the original issue + blast radius. -->

## Resolution

<!-- What changed + why the change solves the problem architecturally.
     Link to code paths, tests, runbooks. -->

- Code change: `<path/to/file.ts>` (commit `<sha>`)
- Test evidence: `<path/to/spec.ts>` — tests that prove the fix works
- Runbook (if applicable): `docs/runbooks/<name>.md`

## Ongoing controls

<!-- What prevents regression? A CI invariant? A schema gate? A
     compile-time type contract? Name the mechanism — do not just
     say "code review". -->

- CI invariant: `<path/to/invariant.spec.ts>`
- Architectural guard: `<mechanism>`

## Auditor notes

<!-- Free-form notes useful for the auditor: corner cases considered,
     rejected alternatives, dependencies on upstream phases. -->
