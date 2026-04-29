# Backend i18n Contract Specification

> **Status:** OPEN — design specification only. Implementation requires
> a team review of the `@nestjs/i18n` dependency adoption + a locale-
> priority decision the spec proposes but does NOT unilaterally lock in.
>
> **Closes (when implemented):** Phase 7.1 of the farm-module plan
>
> **Related:** `apps/farm-service/src/common/errors/farm-app-error.ts`
> (the existing AppError base class that this contract refactors through),
> `apps/farm-service/src/filters/global-exception.filter.ts` (the
> integration point for outgoing error responses)

## Why this contract exists

User-facing strings produced by farm-service today — error messages,
validation rejection reasons, enum descriptions — ship in a mix of
Turkish and English depending on which developer wrote which line.
A Norwegian Mattilsynet operator opening the audit log sees a TR
"Kapasite aşıldı" alongside an EN "Tank capacity exceeded" alongside
a localised regulatory error from the regulatory module. The user
experience is incoherent.

Phase 7.1 of the farm-module plan calls for a backend i18n strategy
that resolves three things at once:

1. **Locale priority** — which language is the canonical source-of-
   truth for new strings, and what's the fallback chain when a
   translation is missing?
2. **Translation infrastructure** — `@nestjs/i18n`-style runtime
   message resolution vs. compile-time string interpolation.
3. **Refactor scope** — which existing strings get migrated, which
   stay untranslated, and what's the migration order?

This document fixes those three architecturally so the implementing
PR has a reviewable target.

## Recommended locale priority (open for review)

| Tier | Locale | Rationale |
|---|---|---|
| **Primary (canonical)** | `tr` (Turkish) | Existing codebase strings + Turkish operator audience + Mattilsynet's TR docs in regulatory module |
| **Secondary** | `en` (English) | International contributors + cross-team review + technical / API documentation |
| **Tertiary** | `no` (Norwegian Bokmål) | Mattilsynet operator-facing strings (compliance reports, regulatory error messages) |

Fallback chain: `tr → en` for any string that lacks a Norwegian
translation. Turkish is the source of truth; English is the
documentation language; Norwegian is the regulatory-facing
delivery.

The implementing PR's first decision is whether to adopt this
priority or push back. The 13 farm-service docblocks I sampled
during the contract drafting all wrote primary content in Turkish
with English code comments — which matches the proposed priority.

## What this contract specifies

### 1. The `@nestjs/i18n` dependency adoption

```jsonc
// package.json
{
  "dependencies": {
    "@nestjs/i18n": "^10.5.0"
  }
}
```

Why `@nestjs/i18n` over alternatives:

| Option | Why rejected for this scope |
|---|---|
| `i18next` directly | Doesn't integrate with Nest's request-scoped `Logger` / `ExceptionFilter`. Would require building the Nest glue ourselves. |
| `gettext`-style `.po` files | Manual extraction tooling burden; no IDE support for our TypeScript-first stack. |
| Compile-time string keys (e.g. `errors.capacity.exceeded`) | Sounds clean but the production codebase already has hundreds of inline strings; refactoring all of them at once is the kind of "big bang" the directive forbids. |

`@nestjs/i18n` chosen because:
- Native Nest integration (decorators, request-scoped resolver).
- JSON-based translation files — IDE autocomplete + type-safe with
  the right config.
- Supports both compile-time keys (for new code) AND runtime
  message templating (for the existing inline strings during
  migration).

### 2. Translation file layout

```
apps/farm-service/src/i18n/
  ├── tr/
  │   ├── errors.json
  │   ├── enums.json
  │   ├── regulatory.json
  │   └── compliance.json
  ├── en/
  │   ├── errors.json
  │   ├── enums.json
  │   ├── regulatory.json
  │   └── compliance.json
  └── no/
      ├── errors.json
      ├── enums.json
      ├── regulatory.json
      └── compliance.json
```

**Per-domain split** rather than one mega-file because:
- Errors are the highest-traffic strings; isolating them lets the
  `ExceptionFilter` lazy-load just `errors.json`.
- Regulatory + compliance strings have stricter review (legal sign-
  off for Mattilsynet wording).
- Enums map 1:1 to GraphQL `registerEnumType` calls; a single file
  for those keeps the registration site terse.

### 3. The user-locale extraction contract

```typescript
// In libs/backend-common/src/auth/jwt-claims.ts
export interface JwtClaims {
  sub: string;
  tenantId: string;
  roles: string[];
  /**
   * Phase 7.1 — preferred locale per RFC 5646.
   * Populated by auth-service from the user's profile.locale field.
   * Optional because pre-7.1 tokens predate the claim; consumers
   * fall back to the platform default ('tr') when missing.
   */
  locale?: 'tr' | 'en' | 'no';
}
```

`@nestjs/i18n`'s `I18nResolver` is wired to read this claim:

```typescript
// apps/farm-service/src/common/i18n/jwt-i18n-resolver.ts
@Injectable()
export class JwtI18nResolver implements I18nResolver {
  resolve(context: ExecutionContext): string {
    const req = context.switchToHttp().getRequest<{ user?: JwtClaims }>();
    return req.user?.locale ?? 'tr';
  }
}
```

The resolver applies to BOTH HTTP and GraphQL contexts (Nest's
`ExecutionContext` abstraction handles the differentiation).

### 4. The error-class refactor pattern

`FarmAppError` (`apps/farm-service/src/common/errors/farm-app-error.ts`)
gains an `i18nKey` field:

```typescript
// Before
throw new FarmAppError({
  userMessage: 'Tank kapasitesi aşıldı',
  code: 'TANK_CAPACITY_EXCEEDED',
  // ...
});

// After
throw new FarmAppError({
  i18nKey: 'errors.tank.capacityExceeded',
  i18nArgs: { tankCode: tank.code, projected: capacity.projectedDensityKgM3 },
  code: 'TANK_CAPACITY_EXCEEDED',
  // ...
});
```

`GlobalExceptionFilter` resolves the `i18nKey` against the request's
locale via `I18nService.translate()` and produces the final
`userMessage` for the GraphQL `extensions.userMessage` field.

`userMessage` itself stays on the type as a fallback for code paths
that haven't been migrated yet — the `i18nKey` is opt-in until every
call site is moved.

### 5. The migration order

| Phase | Scope | Why this order |
|---|---|---|
| 7.1.1 | `@nestjs/i18n` dep + `i18n/` directory + `JwtI18nResolver` + the 5 most-thrown error classes | Establishes the pattern + gets the hottest path translated |
| 7.1.2 | Every `FarmAppError` subclass + every `BadRequestException` with a hand-crafted message | Most operator-visible strings |
| 7.1.3 | `registerEnumType` descriptions across all domain enums | GraphQL schema strings; lower-traffic but compliance-visible |
| 7.1.4 | Regulatory module strings (Mattilsynet reports + error messages) | Highest-stakes; needs legal sign-off on Norwegian wording |
| 7.1.5 | Validator decorator messages (`class-validator` `@MaxLength('...')` etc.) | Lowest-stakes; lots of strings but rare in user-facing flows |

The implementing PR opens 7.1.1 only. Subsequent phases land in
their own PRs so each can be reviewed by the appropriate domain
owner (compliance review for 7.1.4, etc.).

## What this contract does NOT specify

- **Frontend i18n** — `web/shared-ui/src/i18n/locales/{en,tr}.ts`
  already exists per the audit; that surface is independent and
  out of farm-service's scope.
- **Email / SMS templates** — handled by notification-service, not
  farm-service. Cross-service coordination if both need to share a
  glossary.
- **PDF / report generation** — regulatory-service builds
  Mattilsynet PDFs with strings that may overlap; coordinated in
  Phase 7.1.4 review.

## Architectural decision: rejected alternatives

| Alternative | Why rejected |
|---|---|
| Single global locale (no per-user) | Misses the case where one tenant has both TR and NO operators. Per-user locale is what the JWT claim is for. |
| Locale from request `Accept-Language` header | Browsers default this to OS locale; doesn't survive non-browser clients (mobile app, NATS-to-WS bridge). JWT claim survives every client because the user authenticated once. |
| Big-bang refactor of all strings at once | Too risky. The phased migration order lets each phase ship independently, with rollback granularity per phase. |

## Acceptance criteria (Phase 7.1.1's PR)

- [ ] `@nestjs/i18n` dependency added to root `package.json`.
- [ ] `apps/farm-service/src/i18n/{tr,en,no}/errors.json` populated for the
      5 most-thrown error classes.
- [ ] `JwtI18nResolver` wired into `app.module.ts` via
      `I18nModule.forRoot({ resolvers: [JwtI18nResolver] })`.
- [ ] `JwtClaims.locale` field added to the auth-service contract +
      auth-service updated to populate it from user profile (cross-
      service PR; coordinate before merging this one).
- [ ] `FarmAppError` extends with `i18nKey` + `i18nArgs` fields;
      existing `userMessage`-only code paths unchanged.
- [ ] `GlobalExceptionFilter` resolves `i18nKey` when present;
      falls back to `userMessage` otherwise.
- [ ] Tests cover: TR locale, EN fallback, NO locale, missing-claim
      defaults to TR.
- [ ] Closing PR's commit message carries
      `Closes: FARM-MEDIUM-011` (or whatever finding ID gets
      registered alongside this doc).

## Closure path

When the implementing PR for Phase 7.1.1 lands:
1. Closes the migration's first slice with `@nestjs/i18n` wired + 5 error classes translated.
2. Subsequent PRs (7.1.2 through 7.1.5) land independently against the same contract.
3. This document either gets archived as the historical contract OR edited inline as the migration progresses to record any design changes.
