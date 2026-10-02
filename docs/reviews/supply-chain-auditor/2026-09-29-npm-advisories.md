# Supply-chain review — 2026-09-29: four packages behind newly published advisories

- Date: 2026-09-29
- Owner: `okan`
- Trigger: the required `security-audit` check went red on `main` at `ef11872aa`
  (run 36540031134), a merge that touched no dependency file; the advisories were
  published against an unchanged lockfile (the trigger gap is `SUPPLY-MEDIUM-010`)
- Method: every claim executed against `scripts/ci/npm-audit-gate.mjs` with the
  workflow's own audit commands, leg by leg

## SUPPLY-HIGH-014 — ip-address, multer, nodemailer and fast-uri

The gate step exited on the first failing leg, so CI named only root-production.
Running all six legs against `origin/main` found two more red legs (the gate
defect is fixed in this PR, see "Gate reports every leg" below):

| leg             | package    | resolved | advisories                               | patched |
| --------------- | ---------- | -------- | ---------------------------------------- | ------- |
| root-production | ip-address | 10.4.0   | GHSA-rpw4-54j3-4h4q, GHSA-2vr4-cq9g-pvrc | 10.5.1  |
| root-production | multer     | 2.3.0    | GHSA-3pph-fpjx-jg34                      | 2.4.0   |
| root-production | nodemailer | 9.1.1    | GHSA-6vj9-mwq6-2f5v                      | 10.0.2  |
| aquamobil-full  | fast-uri   | 3.1.6    | GHSA-qw65-cvwx-89v3, GHSA-58mr-gqgx-xq4g | 3.1.7   |
| e2e-full        | fast-uri   | 3.1.6    | GHSA-qw65-cvwx-89v3, GHSA-58mr-gqgx-xq4g | 3.1.7   |

`@nestjs/platform-express` and `ajv` also appear in the report; both are
attributions (they depend on multer and fast-uri), not advisories of their own.

- ip-address: `Address6.isLinkLocal()` matched fe80::/64 instead of fe80::/10,
  and no classifier knew the NAT64 local-use range, so an SSRF allow-list built
  on them passes on-link hosts. Reached through `express-rate-limit` and `socks`.
- multer: an aborted upload left its disk write orphaned (DoS by disk fill).
  Reached through `@nestjs/platform-express`; the gateway upload routes use it.
- nodemailer: a process-global DNS cache reused one transport's TLS
  `servername` for another, so a second SMTP transport could present the first
  one's host and send its credentials there. admin-api-service,
  notification-service and sensor-service each build a transport.
- fast-uri: authority injection through an unvalidated port in `serialize`,
  and host confusion on an unclosed bracket. Development-only in both
  standalone lockfiles (through `ajv`).

### Fix

Every advisory is fixed by upgrading; no exception was added.

- `multer` 2.4.0, in `dependencies` and in the root `overrides` pin together.
- `ip-address` override floor `^10.5.1`, resolving 10.7.2 (additive minors).
- `fast-uri` 3.1.8: the root override floor, the aquamobil override pin, and a
  lockfile refresh in `e2e/`. 3.1.8 rather than 3.1.7 because fastify also
  published GHSA-hrr3-gc8f-f4qj (host case normalization, fixed in 3.1.8). It is
  not in npm's advisory feed yet, so the gate would go red again the day it is.
- `nodemailer` 10.0.12. The patched line is 10.x only; npm marks it breaking.

`tests/invariants/dependency-security-floor.spec.ts` carries the floors for all
three trees. In the root tree (the production graph every backend image
installs) it asserts `fast-uri` ≥ 3.1.8, `ip-address` ≥ 10.5.1, `multer` ≥ 2.4.0
and `nodemailer` ≥ 10.0.12, twice: the manifest range (the `fast-uri`,
`ip-address` and `multer` overrides, the `multer` and `nodemailer`
dependencies) and every copy of each package in `package-lock.json`, nested
copies included. The `fast-uri` row is the only guard for GHSA-hrr3-gc8f-f4qj
until npm's feed carries it. Lowering any one of them (override `^3.1.7`, a lock
copy at 3.1.7, 2.3.0, 10.4.0 or 10.0.2, `nodemailer` back to `^9.1.1`) turns
the spec red.

### Why nodemailer 10.0.12 and not 10.0.2

10.0.2 is the first release with the GHSA-6vj9-mwq6-2f5v fix ("shared: keep
the TLS server name out of the DNS cache"). The ten releases after it fix
input-driven parsing and wire-format defects in code these services reach, per
the package's own `CHANGELOG.md`:

- linear-time parsing of attacker-shaped input: addressparser for
  comment-joined addresses (10.0.5) and for free text (10.0.6), a bounded '@'
  probe (10.0.9), multiline SMTP replies and DKIM header unfolding (10.0.10);
- line-break and control-character handling: multipart boundary material
  (10.0.7, 10.0.8) and "turn a bare CR into CRLF" (10.0.12);
- transport behaviour: "honour requireTLS" and "settle every send on a
  connection error, back off pool requeues" (10.0.12), releasing rate-limited
  pool connections on close (10.0.7), and a CommonJS entry point compatible
  with the pre-TypeScript build (10.0.11).

So the adopted release, not the advisory's first fixed release, is the floor
the invariant holds.

### nodemailer 10

The 10.0.0 breaking changes are a Node.js ≥ 20 engine (every backend image runs
Node 22) and a TypeScript rewrite with its own CommonJS and ESM builds and
bundled declarations. `@types/nodemailer` is removed: the bundled declarations
replace it. Checked against the three services:

- `import * as nodemailer` resolves the CommonJS entry, which still exports
  `createTransport`; the SMTP and pool transports construct as before.
- Errors still carry the numeric `responseCode` that notification-service's
  `EmailDeliveryError.fromTransport` classifies (550 permanent, 451 transient).
  `email.service.smtp-contract.spec.ts` in notification-service proves it
  through the service itself: `EmailService` builds its production transport
  (`pool: true`, `requireTLS`, `rejectUnauthorized: true`) against an
  in-process SMTP responder over verified STARTTLS, and a 550 reply surfaces as
  a `permanent` `EmailDeliveryError`, a 451 as `transient`, a delivery as the
  generated Message-ID.
- Types: `@types/nodemailer` typed every send result `any`. The bundled
  declarations type it `SentMessageInfo` with `messageId: string`, so
  admin-api-service no longer re-narrows an `unknown` by hand. In
  sensor-service, `ReturnType<typeof createTransport>` now takes the catch-all
  `Mail<any, any>` overload; the field uses the plain `Transporter` instead.
- 10.0.12 lets `requireTLS` win over `ignoreTLS` and `opportunisticTLS`
  (`dist/cjs/smtp-connection/index.js`: "a contradictory configuration must not
  quietly fall back to plaintext"); no service sets either of those, so no
  connection changes behaviour.

### Real-transport contract specs

Every other e-mail spec mocks nodemailer out. These drive the real library
against the shared in-process responder
(`libs/testing/src/smtp/fake-smtp-server.ts`, `withFakeSmtpServer`: SMTP on
127.0.0.1, optional STARTTLS with a certificate minted in memory and trusted
only while the responder lives, torn down in `finally`):

- notification-service
  `src/notification/services/__tests__/email.service.smtp-contract.spec.ts`:
  the pool transport over verified STARTTLS; Message-ID, 550 → `permanent`,
  451 → `transient`, and against a server without TLS a `transient` ETLS
  failure with nothing delivered (the transport never falls back to
  plaintext).
- sensor-service
  `src/scada-runtime/services/__tests__/notification.service.smtp-contract.spec.ts`:
  `sendDirectEmail`, the SCADA script mail path, which had no test; delivery to
  the requested recipient, and a 550 reply rejects with nodemailer's error
  instead of resolving.
- admin-api-service
  `src/settings/__tests__/email-sender.smtp-contract.spec.ts`: a delivery
  returns the generated Message-ID string, and a 550 surfaces as a failed
  result.

These are library contract tests, not regression tests for this diff: all
three pass with nodemailer 9.1.1 loaded in place of 10.0.12 (the specs run
against the 9.1.1 tarball through a scratch Jest module mapping), so none of
them shows the upgrade was needed. What they guard is that the behaviour the
services rely on — the Message-ID, `responseCode`, STARTTLS with verification,
the rethrown error — still holds after this and any later nodemailer upgrade. Each one goes red when
the behaviour it guards is broken in the service (a 4xx treated as permanent,
the classification ignoring `responseCode`, the reply string returned instead
of the Message-ID, `requireTLS` removed or TLS ignored, a swallowed or
misaddressed SCADA mail).

### Gate reports every leg

The `Gate npm audit on reviewed exceptions` step in `ci-affected.yml` and
`ci-full.yml` ran the six gate calls as a bare sequence; under Actions'
`bash -e` the first red leg ended the step, which is why the two fast-uri legs
were never reported. Each call now records its failure
(`|| FAILED_LEGS="$FAILED_LEGS <leg>"`) and the step fails once, after every
leg has printed its verdict, naming all red legs. The audit flags and the
exception list are unchanged. `dependency-security-floor.spec.ts` pins the
exact script for both workflows and rejects the pre-fix shape.

### After

```text
[npm-audit-gate] root-production: clean at --audit-level=moderate
[npm-audit-gate] root-full: clean at --audit-level=high (15 reviewed exception(s))
[npm-audit-gate] aquamobil-production: clean at --audit-level=moderate
[npm-audit-gate] aquamobil-full: clean at --audit-level=high
[npm-audit-gate] e2e-production: clean at --audit-level=moderate
[npm-audit-gate] e2e-full: clean at --audit-level=high
```

The fifteen exceptions are the nx toolchain rows of `SUPPLY-HIGH-011` and
`SUPPLY-HIGH-012`, unchanged.

### What did not change

The trigger gap stays open: advisories published against an unchanged lockfile
still surface only when some other change runs the gate. That is
`SUPPLY-MEDIUM-010`, not fixed here. The first-red-leg defect that hid two of
the five rows above is fixed here (see "Gate reports every leg").

## 2026-10-02 — SUPPLY-HIGH-014, second wave: advisories published after the 2026-09-29 run

- Date: 2026-10-02
- Trigger: the six legs rerun on this branch after merging `main`
  (`32fa943e6`). None of these advisories failed the 2026-09-29 run recorded
  under "After" above; GitHub published them between 2026-09-28 21:42 and
  2026-10-01 15:03 UTC.
- Method: as above — the workflow's own audit commands, leg by leg, judged by
  `scripts/ci/npm-audit-gate.mjs` with the same flags.

| legs                                                                                   | package               | resolved             | advisories (GitHub publish date)                                                                                                                                                                                                                                           | patched               | now                   | pinned by                                                                                  |
| -------------------------------------------------------------------------------------- | --------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| root-production                                                                        | piscina               | 5.2.0                | GHSA-67c8-pqhq-4rmx critical (10-01)                                                                                                                                                                                                                                       | 5.3.2                 | 5.3.2                 | `dependencies` `^5.3.2`                                                                    |
| root-production                                                                        | @nestjs/microservices | 11.1.27              | GHSA-m8vh-jmq9-5rjg high (09-29), GHSA-96h4-vgxj-gvm2 moderate (09-30)                                                                                                                                                                                                     | 11.2.4, 11.2.5        | 11.2.7                | `dependencies` `^11.2.7`, with the whole lockstep family                                   |
| root-production                                                                        | @grpc/grpc-js         | 1.14.4               | GHSA-m9gg-hp2v-232j high, GHSA-f596-whhp-79r4 low (09-30)                                                                                                                                                                                                                  | 1.14.5                | 1.14.5                | root override `^1.14.5`                                                                    |
| aquamobil-production, aquamobil-full                                                   | @grpc/grpc-js         | 1.9.16               | the same two                                                                                                                                                                                                                                                               | 1.13.6 / 1.14.5       | 1.14.5                | aquamobil override `1.14.5`                                                                |
| root-production                                                                        | engine.io             | 6.6.9                | GHSA-2gc4-cqfq-p2gv high (09-29)                                                                                                                                                                                                                                           | 6.6.10                | 6.6.11                | lockfile (socket.io asks `~6.6.0`)                                                         |
| root-production (5.x), root-full (1.x, 2.x), aquamobil-full (2.x, 5.x), e2e-full (1.x) | brace-expansion       | 5.0.9, 2.1.4, 1.1.18 | GHSA-6j4f-fj2g-mc7p high, GHSA-qhr7-859c-m2p7 high, GHSA-q2hr-2g5m-vwhr moderate (09-29)                                                                                                                                                                                   | 5.0.12, 2.1.7, 1.1.21 | 5.0.12, 2.1.7, 1.1.21 | root overrides `brace-expansion@^5.0.1` / `@^5.0.5` → `^5.0.12`; lockfiles for 1.x and 2.x |
| root-full                                                                              | axios                 | 1.18.1               | GHSA-vh66-26gq-q6x8, GHSA-9fr6-4gfg-395g, GHSA-c29m-xwm3-cm6r, GHSA-mghh-pgcx-3jjj, GHSA-x97p-jq2g-jp4f, GHSA-3pq3-5fj3-cg6v, GHSA-542g-h47m-68v8, GHSA-j8rh-479h-cp32, GHSA-4hqw-qxg8-jxx2, GHSA-m8m8-qj5v-23w3, GHSA-44g4-m2mj-wpvx, GHSA-r4gj-5m52-g5wh (09-30; 7 high) | 1.20.0                | 1.20.0                | root override `^1.20.0`                                                                    |
| root-full                                                                              | undici                | 7.29.0               | GHSA-3wwx-pv8p-q78v (09-28), GHSA-pmjh-fq2x-6v4x, GHSA-r53p-7pc4-xj5r, GHSA-rfgv-xxqx-mfg5, GHSA-3xpg-4rpp-hhhm, GHSA-2jfj-6hjv-fm6j, GHSA-2gqq-gqf2-x968, GHSA-w293-vg96-wgc3, GHSA-8436-99hf-9mmv, GHSA-rx4f-c7p8-82vq (09-29; 2 high)                                   | 7.29.1                | 7.30.0                | root override `^7.29.1`                                                                    |

Root-full's sixteen unexcepted rows were axios, undici, `nx` and every `@nx/*`
package; the nx rows are attributions (npm lists each as a dependent of axios),
not advisories of their own.

### Fix

Every row is fixed by upgrading; no exception was added. Every lockfile change
was made with `--package-lock-only --ignore-scripts`, and both standalone locks
pass `npm ci --package-lock-only` as CI runs it.

- **axios and undici: overrides, no downgrade.** `nx` 22.7.8 declares
  `axios: "1.18.1"`, and `@module-federation/dts-plugin` 2.8.2 (itself pinned
  exactly by `@module-federation/vite` 1.20.8) declares `undici: "7.29.0"`, so
  no range in the graph admits a fix. npm's remediations were `nx@22.7.1` and
  `@module-federation/vite@1.16.10`, both downgrades it marks breaking; neither
  was taken. The overrides stay inside each major: axios 1.18.1 → 1.20.0 (a
  minor; its dependency set is unchanged apart from the `form-data` floor
  `^4.0.5` → `^4.0.6`, which the root override already holds) and undici
  7.29.0 → 7.30.0 (a minor; `testcontainers` asks `^7.24.5`, still satisfied).
- **The Nest family moves together.** `npm audit fix --package-lock-only`
  lifted only `@nestjs/microservices`, to 11.2.7, and left `@nestjs/core` at
  11.1.27. npm accepts that lockfile (the peer range is `^11.0.0`) and it is
  broken: `nest-microservice.js` in 11.2.7 requires
  `@nestjs/core/helpers/safe-instance-decorator`, a file core 11.1.27 does not
  ship, so `require('@nestjs/microservices')` throws `MODULE_NOT_FOUND`
  (reproduced in a scratch install of exactly that pair; the same require
  succeeds with the all-11.1.27 and the all-11.2.7 sets). `@nestjs/common`,
  `core`, `microservices`, `platform-express`, `platform-socket.io` and
  `websockets` now declare `^11.2.7`, and `@nestjs/testing` moves from its exact
  11.1.17 pin to 11.2.7. Checked before taking 11.2.7 for the family:
  - runtime exports of all seven packages: nothing removed; `@nestjs/common`
    adds `QueryMethod`, `SSE_ABORT_CONTROLLER` and `SseSignal`;
  - deep imports: neither the repo's nor any package in the lockfile that
    depends on a family member reaches a file 11.2.7 dropped;
  - `tsc --noEmit` over the 31 backend projects `npm run type-check` covers,
    with the seven packages overlaid at 11.2.7: one break, in gateway-api.
    `@nestjs/platform-socket.io` 11.2.x gives `IoAdapter` a
    `protected readonly logger` (it now logs and contains handler errors and
    failed emits that used to escape and kill the process), and
    `RedisIoAdapter` declared a `private logger` of the same name. It now
    overrides the inherited one (`protected override readonly logger`), so the
    base class's lines and its own both carry the `RedisIoAdapter` context;
  - Jest, with the family swapped to 11.2.7 at runtime and for ts-jest, over
    the 19 projects that import a family member (15 services, backend-common,
    storage, testing, event-bus): every suite passes except four, which fail
    identically under the installed 11.1.27 and are local to the shared
    checkout the run used — the three nodemailer contract specs resolve
    `@aquaculture/testing` to a sibling worktree's `libs/testing` that
    predates `withFakeSmtpServer`, and one alert-engine quiet-hours case reads
    local time against a UTC window on a CEST host.
- **@grpc/grpc-js in AquaMobil: override.** `@firebase/firestore` — its latest
  release included — asks for `~1.9.0`, whose last release is 1.9.16, so no
  firebase upgrade reaches a patched grpc-js. Only firestore's Node build
  (`index.node.*`) loads grpc-js; the PWA bundles the browser build. The root
  graph already resolves the same firestore against grpc-js 1.14.x through its
  own override.
- **piscina, engine.io, brace-expansion, root grpc-js:** a lockfile refresh
  inside the declared ranges, plus the manifest and override floors in the
  table, so the next `npm install` cannot resolve below them.

### Invariants

`tests/invariants/dependency-security-floor.spec.ts`:

- `ROOT_SECURITY_FLOORS` adds axios 1.20.0, brace-expansion (1.1.21 / 2.1.7 /
  5.0.12), engine.io 6.6.10, @grpc/grpc-js 1.14.5, @nestjs/microservices
  11.2.5, piscina 5.3.2 and undici 7.29.1, each with its GHSA ids, checked
  against every copy in `package-lock.json`. A floor can now be one per major
  line: brace-expansion carries three majors, and a copy on a major the table
  does not name fails as unvetted.
- `ROOT_FLOOR_DECLARATIONS` adds the manifest pins: the axios, undici and
  @grpc/grpc-js overrides, both `brace-expansion@^5.0.x` overrides, and the
  piscina and @nestjs/microservices dependencies.
- New: the Nest lockstep members resolve to one release and every root
  declaration of one starts at it. Against the `npm audit fix` lockfile it fails
  naming microservices 11.2.7 and testing 11.1.17 against core 11.1.27; against
  the pre-change lockfile it already failed on testing 11.1.17.
- AquaMobil: the grpc-js override and its single 1.14.5 copy, brace-expansion
  2.1.7 / 5.0.12. E2E: brace-expansion floor 1.1.21.

Against the pre-change manifests and lockfiles the spec fails four tests (root
floors, Nest lockstep, AquaMobil, E2E); after the change all 23 pass.

### After (2026-10-02)

```text
[npm-audit-gate] root-production: clean at --audit-level=moderate
[npm-audit-gate] root-full: clean at --audit-level=high (15 reviewed exception(s))
[npm-audit-gate] aquamobil-production: clean at --audit-level=moderate
[npm-audit-gate] aquamobil-full: clean at --audit-level=high
[npm-audit-gate] e2e-production: clean at --audit-level=moderate
[npm-audit-gate] e2e-full: clean at --audit-level=high
```

The fifteen exceptions are the `SUPPLY-HIGH-011` rows (GHSA-7w5x-hrqm-74c2,
smol-toml through nx), unchanged and expiring 2026-10-16.

### Below the gate level, unchanged

Still reported, failing no leg, and not changed by this section:
GHSA-82fw-gwwq-j7x9 (moderate) in vitest / @vitest/mocker 3.2.7, patched only
in the 4.x major; GHSA-w5hq-g745-h8pq (moderate) in the uuid copy under
dockerode (testcontainers); GHSA-p98j-92pf-mc4p (low) in dompurify 3.4.14,
which root-production also lists as a low; GHSA-r3ph-w7gj-g6xm (moderate) in
e2e's js-yaml 5.4.0.
