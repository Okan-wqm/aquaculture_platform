# Supply-chain review — 2026-09-29: four packages behind newly published advisories

- Date: 2026-09-29
- Owner: `okan`
- Trigger: the required `security-audit` check went red on `main` at `ef11872aa`
  (run 36540031134), a merge that touched no dependency file; the advisories were
  published against an unchanged lockfile (the trigger gap is `SUPPLY-MEDIUM-010`)
- Method: every claim executed against `scripts/ci/npm-audit-gate.mjs` with the
  workflow's own audit commands, leg by leg

## SUPPLY-HIGH-014 — ip-address, multer, nodemailer and fast-uri

The gate step exits on the first failing leg, so CI named only root-production.
Running all six legs against `origin/main` found two more red legs:

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
  `tests/invariants/dependency-security-floor.spec.ts` carries the new floor.
- `nodemailer` 10.0.12. The patched line is 10.x only; npm marks it breaking.

### nodemailer 10

The 10.0.0 breaking changes are a Node.js ≥ 20 engine (every backend image runs
Node 22) and a TypeScript rewrite with its own CommonJS and ESM builds and
bundled declarations. `@types/nodemailer` is removed: the bundled declarations
replace it. Checked against the three services:

- `import * as nodemailer` resolves the CommonJS entry, which still exports
  `createTransport`; the SMTP and pool transports construct as before.
- Errors still carry the numeric `responseCode` that notification-service's
  `EmailDeliveryError.fromTransport` classifies (550 permanent, 451 transient),
  checked with real SMTP errors from both transports.
- Types: `@types/nodemailer` typed every send result `any`. The bundled
  declarations type it `SentMessageInfo` with `messageId: string`, so
  admin-api-service no longer re-narrows an `unknown` by hand. In
  sensor-service, `ReturnType<typeof createTransport>` now takes the catch-all
  `Mail<any, any>` overload; the field uses the plain `Transporter` instead.
- 10.0.12 lets `requireTLS` win over `ignoreTLS` and `opportunisticTLS`; no
  service sets either of those, so no connection changes behaviour.

`apps/admin-api-service/src/settings/__tests__/email-sender.smtp-contract.spec.ts`
drives the real transport against an in-process SMTP responder: a delivery
returns the generated Message-ID string, and a 550 surfaces as a failed result.

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
`SUPPLY-MEDIUM-010`, not fixed here.
