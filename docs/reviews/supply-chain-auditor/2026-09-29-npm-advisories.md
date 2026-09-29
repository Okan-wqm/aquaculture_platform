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
