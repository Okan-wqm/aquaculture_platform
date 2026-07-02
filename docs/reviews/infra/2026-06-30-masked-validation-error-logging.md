# Masked validation-error logging (platform bootstrap)

## INFRA-MEDIUM-037 — production ValidationPipe masks validation failures with no server-side log
**Severity:** MEDIUM · **Layer:** 1 (platform bootstrap) · **Owner:** infra-expert

### Problem
`configureValidationPipe` (`libs/backend-common/src/bootstrap/create-service-app.ts`) sets
`disableErrorMessages: isProduction`. In production this strips all field-level detail from the
client response — every class-validator rejection becomes a bare `400 "Bad Request"` — AND
nothing is logged server-side. A masked 400 is therefore undiagnosable from logs: an operator
sees "Bad Request" in the gateway response, the same in the service log (`GlobalExceptionFilter`
re-logs the masked message), and has no way to learn WHICH field failed WHICH constraint without
reproducing the DTO in a local class-validator harness. This cost real production debugging time
(e.g. a masked createFeed rejection that reached `ValidationPipe` with no resolver log and no
field detail anywhere).

### Fix (architectural Tier-3 — make the wrong behaviour detectable)
Add a logging `exceptionFactory` to the shared ValidationPipe defaults. It ALWAYS emits the
failing field paths + constraint messages to the service log (structured, PII-safe — property
paths + constraint text only, never the rejected values, since `validationError.value` is already
hidden), while the **client response stays masked in production** (the factory returns a bare
`BadRequestException()` when `isProduction`, the flattened detail otherwise). One shared change
covers every service that bootstraps via `bootstrapService`/`createServiceApp`. Services can still
override via `validationPipeOverrides.exceptionFactory`.

### Verification
`tsc -p libs/backend-common/tsconfig.spec.json` → 0; `npm run invariants:fast` → 134/134.
Post-deploy: a rejected mutation now logs `RequestValidation Request validation failed:
{"fields":[{"field":"...","constraints":["..."]}]}` in the service container log while the client
still receives the masked `400 "Bad Request"`.
