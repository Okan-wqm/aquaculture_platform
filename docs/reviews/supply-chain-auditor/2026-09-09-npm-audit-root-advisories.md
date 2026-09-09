# Supply-chain review — 2026-09-09: eighteen advisories, five real packages

- Date: 2026-09-09
- Owner: `okan`
- Trigger: `security-audit` went red on an unrelated PR whose only `package.json`
  change was a two-line script rename
- Method: every claim executed against the repo's own gate

## How this surfaced

PR #1516 renamed one npm script. `security-audit` runs when
`needs.detect-changes.outputs.dependency_audit_required == 'true'`, and that
flag is raised by any `package.json` edit — not by a dependency change. The
rename tripped the gate, and the gate reported eighteen advisories at or above
moderate in root-production dependencies.

`package-lock.json` on that branch was byte-identical to `origin/main`. The
advisories were not introduced by the PR; they were already live on `main` and
nothing had reported them.

That is `SUPPLY-MEDIUM-010`, recorded below and not fixed here.

## SUPPLY-HIGH-009 — thirteen of the eighteen were one transitive package wearing thirteen names

The gate's output named thirteen `@nestjs/*` packages, each carrying the same
four GHSAs, and npm's suggested remedies were breaking downgrades — `@nestjs/core`
to `@nestjs/platform-socket.io@7.6.18`, `@nestjs/cqrs@7.0.1`, `@nestjs/terminus@7.2.0`,
and so on. Taken at face value that is a multi-package NestJS 11 → 7 downgrade
across the whole backend.

Reading the audit JSON's `via` chains instead of its `fixAvailable` field gives a
different picture. Only **five** entries are root advisories — packages whose own
code is vulnerable:

| package    | vulnerable range | patched |
| ---------- | ---------------- | ------- |
| multer     | `<2.3.0`         | 2.3.0   |
| js-yaml    | `>=4.0.0 <4.3.2` | 4.3.2   |
| hono       | `<4.13.5`        | 4.13.5  |
| nodemailer | `<=9.1.0`        | 9.1.1   |
| sharp      | `<0.35.4`        | 0.35.4  |

The other thirteen are attributions. `multer` is a dependency of
`@nestjs/platform-express`, which is a dependency of `@nestjs/core`, which
eleven more `@nestjs/*` packages depend on; `js-yaml` reaches `@nestjs/swagger`
the same way. npm walks that graph and reports the advisory against every
ancestor, then suggests the only fix it can express in terms of a direct
dependency — a downgrade of the ancestor.

Every one of the five patched versions sits **inside its current major**. The
fix is five version bumps, not thirteen breaking downgrades.

Note on `nodemailer`: three of its four advisories clear at 9.1.0, but
`resolveContent()` is ranged `<=9.1.0`, so 9.1.0 is not enough and 9.1.1 is the
floor. Taking `latest` (10.0.1) would have been a needless major.

### Nested development copies

Two `js-yaml` copies sat below the reach of a top-level range:

- `@istanbuljs/load-nyc-config` nests js-yaml **3.x** and needs that API, so it
  takes `^3.15.2` rather than being forced to 4.
- `@redocly/openapi-core` nested 4.3.1. A per-parent override did not reach it;
  stating the floor once at the top level (`"js-yaml": "^4.3.2"`) deduped the
  nested copy away entirely, with the `@istanbuljs` rule carving out the one
  subtree that must stay on 3.

`svgo` 3.3.4 → 3.3.5 cleared the last high in the development tree. `e2e/`
carries its own lockfile and needed the same `@istanbuljs` carve-out.

## SUPPLY-MEDIUM-010 — the gate keys on the wrong file (OPEN)

- Owner: `okan`
- Deadline: 2026-10-31

Advisories are published against a lockfile that does not change. A gate that
runs only when `package.json` is edited therefore cannot see them: the tree can
become vulnerable while every file in the repo stays byte-identical. Eighteen
advisories accumulated on `main` in exactly that window, and what finally
surfaced them was an unrelated script rename.

Keying `dependency_audit_required` on `package-lock.json` fixes the false
trigger but not the blind spot — a lockfile that does not change still never
fires. The shape that actually closes it is a scheduled audit run against `main`,
so the question "is the tree vulnerable today" is asked on a clock rather than
on an edit. That is a workflow change with its own scheduling and
noise-budget decisions, so it is recorded rather than bundled into this fix.

## An unrelated latent bug found while editing the manifest

`overrides` in the root `package.json` carried two duplicate keys:

```text
"browserslist": "4.28.9"   … later …   "browserslist": "^4.28.7"
"qs":           "^6.15.4"  … later …   "qs":           "^6.16.0"
```

JSON takes the last occurrence, so the effective values were `^4.28.7` and
`^6.16.0` — the first of each pair had no effect. Anyone pinning a version by
editing the first occurrence would have watched their change do nothing. The
duplicates are collapsed to their effective values in this change; no resolved
version moves.

## Verification

Run against this branch, with the repo's own commands:

- All six `npm-audit-gate` scopes clean: `root-production`, `root-full`,
  `aquamobil-production`, `aquamobil-full`, `e2e-production`, `e2e-full`.
- `npm run type-check`: all 41 projects green.
- `nx run-many --target=test` for the three services that import the bumped
  packages directly (`messaging-service` → sharp, `notification-service` and
  `admin-api-service` → nodemailer): passed.
- `dependency-security-floor`, `npm-audit-exception-ssot`,
  `dependency-policy-source-scope`, `dependabot-lockfile-coverage` and
  `workflow-npm-script-references` invariants: 48 tests passed.

`scripts/ci/npm-audit-exceptions.json` remains **empty**. Nothing here was
waived; every advisory was fixed.
