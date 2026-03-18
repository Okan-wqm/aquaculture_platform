# Frontend -> Backend Data Flow for Tenant Isolation

This document traces how a browser request from a microfrontend module reaches the
correct tenant schema in PostgreSQL. Every layer in the chain is covered so that
reviewers can verify that tenant isolation is never broken.

**Last verified:** 2026-03-18 (independent code audit by Frontend Architect agent)

---

## 1. End-to-End Flow Diagram

```
Browser (MFE)
  |
  |  1. User logs in via Login mutation (graphqlClient.request)
  |     -> auth-service returns { accessToken, user.tenantId }
  |     -> accessToken stored in CLOSURE VARIABLE (never in localStorage)
  |     -> tenantId stored in closure var + localStorage('tenant_id')
  |     -> refreshToken set as httpOnly cookie by server (never in JS)
  |
  v
shared-ui  GraphQLClient.request()
  |
  |  2. Builds HTTP request:
  |     Header: Authorization: Bearer <accessToken>   <- from closure / window.__AQUACULTURE_AUTH__
  |     Header: X-Tenant-Id: <tenantId>               <- from closure / localStorage
  |     Header: X-Request-Id: <crypto.randomUUID()>
  |     credentials: 'include'                        <- sends httpOnly cookie
  |
  v
nginx  (port 443 HTTPS / port 8080 dev)
  |
  |  3. Rate-limits (limit_req zone=api burst=50 nodelay)
  |     location /graphql -> proxy_pass http://gateway
  |     Preserves ALL client headers (Authorization, X-Tenant-Id, Cookie)
  |     Does NOT strip or rewrite auth headers
  |
  v
gateway-api  (port 3000)
  |
  |  4. Middleware chain (AppModule.configure, order matters):
  |     a. MetricsMiddleware        - records request timing
  |     b. CorrelationIdMiddleware  - assigns/forwards X-Correlation-Id
  |     c. RequestContextMiddleware - creates AsyncLocalStorage context
  |     d. JwtMiddleware            - verifies JWT (HS256 only), sets req.user
  |     e. UserContextMiddleware    - hydrates req.user from x-user-payload
  |     f. TenantContextMiddleware  - resolves tenant (header > JWT > query > subdomain)
  |                                   *** NOTE: header has HIGHER priority than JWT ***
  |     g. RequestLoggingMiddleware - structured request log
  |
  |  5. Guards (global, run after middleware):
  |     a. AuthGuard                - validates JWT, checks blacklist, type=access
  |     b. RateLimitGuard           - per-tenant rate limiting
  |     *** TenantIsolationGuard exists but is NOT registered globally ***
  |
  |  6. Apollo Federation Gateway (AuthenticatedDataSource.willSendRequest):
  |     Forwards to subgraph services:
  |       authorization      <- original Authorization header
  |       cookie             <- httpOnly refresh token cookie
  |       x-tenant-id        <- req.user?.tenantId ?? req.headers['x-tenant-id']
  |                             (JWT preferred over header AT THIS LAYER)
  |       x-user-id          <- req.user.sub
  |       x-user-roles       <- JSON.stringify(req.user.roles ?? [])
  |       x-user-payload     <- JSON.stringify(req.user) -- full JWT payload
  |       x-correlation-id   <- distributed tracing
  |       traceparent        <- W3C trace context
  |
  v
subgraph service  (farm / sensor / hr / hydroponics / ai)
  |
  |  7. Service middleware chain (e.g. farm-service AppModule.configure):
  |     a. CorrelationIdMiddleware  - assigns/forwards X-Correlation-Id
  |     b. RequestContextMiddleware - AsyncLocalStorage for this service
  |     c. UserContextMiddleware    - reconstructs req.user from x-user-payload
  |     d. TenantContextMiddleware  - resolves tenantId from header > JWT > query
  |     e. TenantSchemaMiddleware   - resolves schema name:
  |        - reads tenantId from req.tenantId || req.user?.tenantId
  |        - validates UUID format (SQL injection prevention)
  |        - computes schema: tenant_{first16chars_no_hyphens_lowercase}
  |        - verifies schema exists (LRU-cached pg query, max 1000, 5 min TTL)
  |        - sets req.schemaName + AsyncLocalStorage ctx.schemaName
  |        - NO FALLBACK: throws UnauthorizedException if tenant schema missing (D05-H1)
  |
  |  8. Guards (global, run after middleware):
  |     a. TenantGuard              - validates tenantId is present, valid UUID,
  |                                   and req.user.tenantId matches
  |     b. RolesGuard               - enforces @Roles() decorator authorization
  |
  |  9. TenantConnectionBootstrap (OnModuleInit):
  |     - Monkey-patches pg Pool.connect()
  |     - On every connection checkout, reads ctx.schemaName from ALS
  |     - Executes: SET search_path TO "tenant_xxx", farm, public
  |     - Validates schemaName with /^[a-z0-9_]+$/ regex before injection
  |     - Transparent to all TypeORM repositories / QueryRunners
  |
  v
PostgreSQL
  |
  | 10. Query runs against the tenant-specific schema
  |     e.g. SELECT * FROM "tenant_4b529829ea7948da"."sites"
  |     Connection returned to pool; next checkout sets fresh search_path
```

---

## 2. Key Configuration Points

### 2.1 Shell App -- Provider Hierarchy

**File:** `web/shell/src/bootstrap.tsx`

```tsx
<React.StrictMode>
  <QueryClientProvider>        // React Query (5 min stale, 30 min GC, 3 retries)
    <ConfiguredBrowserRouter>
      <AuthProvider>           // login/logout, JWT management, role checks
        <TenantProvider>       // tenant state (switchTenant NOT yet implemented)
          <App />
        </TenantProvider>
      </AuthProvider>
    </ConfiguredBrowserRouter>
  </QueryClientProvider>
</React.StrictMode>
```

The shell is the single source of truth for auth state. MFE modules
loaded via Module Federation share the same React context tree because
`@aquaculture/shared-ui` is configured as a Module Federation shared
singleton in every MFE's `vite.config.ts`.

### 2.2 Token Storage Architecture

**File:** `web/shared-ui/src/utils/api-client.ts`

| Token/Data | Storage Location | Rationale |
|------------|-----------------|-----------|
| Access token (JWT) | Closure variable (`let accessToken`) | XSS-resistant: not in localStorage/sessionStorage |
| Refresh token | httpOnly cookie (server-set) | Never accessible to JS |
| Tenant ID | Closure variable + `localStorage('tenant_id')` | Non-sensitive; localStorage is a fallback for page reload |

**Session restoration on page reload:**
1. `AuthProvider.useEffect` calls `silentRefresh()`
2. `silentRefresh()` sends `refreshToken` mutation with `credentials: 'include'`
3. Browser automatically sends the httpOnly cookie
4. Server returns new `accessToken` + `user.tenantId`
5. Stored back into closure variables via `setTokens()` / `setTenantId()`

### 2.3 Shared GraphQL Client -- Token + Tenant Injection

**File:** `web/shared-ui/src/utils/api-client.ts`

- **Singleton:** `export const graphqlClient = new GraphQLClient()`
- **Access token:** kept in a closure variable (`let accessToken`), never in
  localStorage. On every `request()` call, `getAccessToken()` reads the
  closure variable first, then falls back to `window.__AQUACULTURE_AUTH__`.
- **Tenant ID:** `getTenantId()` reads closure first, then window global,
  then `localStorage('tenant_id')`.
- **X-Tenant-Id header:** set on every GraphQL and REST request.
- **Module Federation bridge:** `window.__AQUACULTURE_AUTH__` is a frozen object
  with `getAccessToken()` and `getTenantId()` -- MFE bundles that load separate
  copies of shared-ui fall back to this global if their closure-scoped token is
  null (SEC-016: non-writable, non-configurable property via Object.defineProperty).
- **401 retry:** on HTTP 401 or UNAUTHENTICATED GraphQL error, attempts a single
  `refreshAccessToken()` via httpOnly cookie, then retries. Capped at 1 retry
  via `retryCount` parameter (CRIT-01). Also restores tenantId from refresh
  response (ARCH-AUTH-001).
- **REST client:** `RestClient` class uses identical auth header injection and
  401 retry logic.

### 2.4 MFE Module Client Usage -- Verified Per Module

All MFE modules use the shared client. No MFE creates its own Apollo Client or
independent GraphQL client. Verified patterns:

| Module | Client Source | X-Tenant-Id | Notes |
|--------|-------------|-------------|-------|
| **dashboard** | `graphqlClient` from `@aquaculture/shared-ui` | Auto | Shared singleton |
| **farm-module** | `graphqlClient` from `@aquaculture/shared-ui` | Auto | Shared singleton |
| **hr-module** | `graphqlClient` via `useGraphQLClient()` wrapper | Auto | Wrapper delegates to shared singleton |
| **sensor-module** | `graphqlFetch()` in `src/config/api.ts` | Explicit | Custom fetch helper that calls `getAccessToken()` + `getTenantId()` from shared-ui |
| **sensor-module** | `graphqlFetch()` in `src/hooks/useSensorRegistration.ts` | Explicit | Duplicate helper; same pattern |
| **hydroponics-module** | `graphqlClient` from `@aquaculture/shared-ui` | Auto | Shared singleton |
| **tenant-admin** | `apiFetch()` in `src/services/tenantApi.ts` | Explicit | REST client; calls `getAccessToken()` + `getTenantId()` from shared-ui |
| **admin-panel** | `graphqlClient` from `@aquaculture/shared-ui` | Auto | Shared singleton |

**Observation:** sensor-module has two custom `graphqlFetch` helpers (one in
`src/config/api.ts`, one in `src/hooks/useSensorRegistration.ts`) that correctly
call `getAccessToken()` / `getTenantId()` from shared-ui and set the headers
manually. These bypass the shared client's 401 retry logic but DO correctly
include tenant headers.

### 2.5 Gateway -- Header Forwarding to Subgraphs

**File:** `apps/gateway-api/src/app.module.ts` (class `AuthenticatedDataSource`)

The gateway does **not** use Apollo Client. It is an Apollo Federation Gateway
that composes subgraph schemas via `RetryableIntrospectAndCompose`. The
`AuthenticatedDataSource.willSendRequest()` method forwards:

| Header | Source | Purpose |
|--------|--------|---------|
| `authorization` | `req.headers.authorization` | Bearer token for subgraph auth |
| `cookie` | `req.headers.cookie` | httpOnly refresh token |
| `x-tenant-id` | `req.user?.tenantId ?? req.headers['x-tenant-id']` | Tenant isolation (JWT preferred) |
| `x-user-id` | `req.user.sub` | User identity for subgraph `@CurrentUser()` |
| `x-user-roles` | `JSON.stringify(req.user.roles ?? [])` | Role-based access in subgraphs |
| `x-user-payload` | `JSON.stringify(req.user)` | Full decoded JWT for subgraph middleware |
| `x-correlation-id` | `req.headers['x-correlation-id']` | Distributed tracing |
| `traceparent` | `req.headers['traceparent']` | W3C trace context |
| `x-trace-id` | `req.headers['x-trace-id']` | Custom trace ID |
| `x-span-id` | `req.headers['x-span-id']` | Custom span ID |
| `x-parent-span-id` | `req.headers['x-parent-span-id']` | Custom parent span ID |

**Security note:** The JWT is decoded and verified by `JwtMiddleware` (HS256 only,
explicit algorithm restriction via `algorithms: ['HS256']`) BEFORE the GraphQL
context is created. The context factory only passes `{ req, res }` through -- it
never decodes JWT itself. `AuthGuard` runs as an additional validation layer with
blacklist checking.

### 2.6 Service-Level Tenant Schema Resolution

**File (example):** `apps/farm-service/src/middleware/tenant-schema.middleware.ts`

Each backend service has its own `TenantSchemaMiddleware` that:

1. Reads `tenantId` from `req.tenantId || req.user?.tenantId`
   (populated by `UserContextMiddleware` from `x-user-payload` header, then
   `TenantContextMiddleware` from `x-tenant-id` header)
2. Validates UUID format with regex: `/^[0-9a-f]{8}-...$/i`
3. Computes `tenant_{cleanId.substring(0,16).toLowerCase()}`
4. Verifies schema existence via parameterized query against `information_schema.schemata`
   (LRU-cached, max 1000 entries, 5 min TTL)
5. Stores result in `req.schemaName` AND `AsyncLocalStorage` (via `getRequestContext().schemaName`)
6. **Does NOT fall back** to the shared schema when tenantId is present but schema
   is missing -- throws `UnauthorizedException` (D05-H1 fix)
7. Falls back to `DEFAULT_SCHEMA` (e.g., `'farm'`) only when no tenantId is present
   (unauthenticated/public endpoints)

### 2.7 Pool-Level search_path Injection

**File (example):** `apps/farm-service/src/infrastructure/tenant-connection-bootstrap.service.ts`

`TenantConnectionBootstrap` runs once at module init (`OnModuleInit`) and patches
`pg.Pool.connect()`:

```
pool.connect(callback) -> originalConnect(callback) -> {
  schemaName = getRequestContext().schemaName;
  if (schemaName && schemaName !== 'farm' && /^[a-z0-9_]+$/.test(schemaName)) {
    client.query(`SET search_path TO "${schemaName}", farm, public`);
  }
  callback(null, client, done);
}
```

Key details:
- Regex validation `/^[a-z0-9_]+$/` prevents SQL injection in SET search_path
- Both callback-style (TypeORM internal) and promise-style patched
- If schemaName equals the source schema or is absent, search_path is NOT set
  (uses the default from connection string: `-c search_path=farm,public`)

---

## 3. End-to-End Trace: "Add Site" in farm-module

### Step-by-step:

1. **User clicks "Add Site" in farm-module UI**
   - Component calls `graphqlClient.request(CREATE_SITE_MUTATION, { input: {...} })`
   - This is the shared `GraphQLClient` instance from `@aquaculture/shared-ui`

2. **GraphQL mutation sent with headers:**
   ```
   POST /graphql HTTP/1.1
   Content-Type: application/json
   Authorization: Bearer <accessToken>           <- from closure variable
   X-Tenant-Id: 4b529829-ea79-48da-982c-cd6fbec8ffb7  <- from closure/localStorage
   X-Request-Id: a1b2c3d4-...                    <- crypto.randomUUID()
   Cookie: refreshToken=...                      <- httpOnly, automatic
   ```

3. **nginx receives and forwards:**
   - `location /graphql { proxy_pass http://gateway; }`
   - All original headers preserved (no stripping)
   - Adds `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`

4. **gateway-api middleware chain processes:**
   - `JwtMiddleware`: verifies JWT signature (HS256), sets `req.user = { sub, tenantId, roles, ... }`
   - `TenantContextMiddleware`: reads `x-tenant-id` header, sets `req.tenantId`
   - `AuthGuard`: validates token type=access, checks blacklist
   - `AuthenticatedDataSource.willSendRequest()`:
     - Sets `x-tenant-id` = `req.user.tenantId` (JWT preferred over header)
     - Sets `x-user-payload` = `JSON.stringify(req.user)`
     - Forwards `authorization`, `cookie`

5. **farm-service middleware chain processes:**
   - `UserContextMiddleware`: parses `x-user-payload` header, sets `req.user`
   - `TenantContextMiddleware`: reads `x-tenant-id` header, sets `req.tenantId`
   - `TenantSchemaMiddleware`:
     - Reads `req.tenantId` = `4b529829-ea79-48da-982c-cd6fbec8ffb7`
     - Validates UUID format
     - Computes schema: `tenant_4b529829ea7948da`
     - Verifies schema exists (parameterized query, cached)
     - Sets `req.schemaName = 'tenant_4b529829ea7948da'`
     - Stores in `AsyncLocalStorage` via `getRequestContext().schemaName`

6. **TenantGuard** validates tenantId is present and matches `req.user.tenantId`

7. **GraphQL resolver calls `SiteService.create()` -> `SiteRepository.save()`**
   - TypeORM internally calls `pool.connect()` to get a connection
   - **Patched `pool.connect()`** intercepts:
     - Reads `schemaName = 'tenant_4b529829ea7948da'` from AsyncLocalStorage
     - Executes `SET search_path TO "tenant_4b529829ea7948da", farm, public`
   - TypeORM runs: `INSERT INTO "sites" ... VALUES ...`
   - Because search_path is set, this resolves to `tenant_4b529829ea7948da.sites`

8. **Connection returned to pool; next request gets fresh search_path**

---

## 4. Risk Points and Mitigations

### 4.1 Missing JWT / Invalid Token

| Scenario | What happens |
|----------|-------------|
| No Authorization header | `JwtMiddleware` skips (no error). `AuthGuard` throws `UnauthorizedException` ('Missing auth header'). |
| Invalid/expired JWT | `JwtMiddleware` logs debug error, does NOT set `req.user`. `AuthGuard` re-verifies and throws `UnauthorizedException`. |
| Tampered JWT (tenantId changed) | `JwtMiddleware` HS256 verification fails. `req.user` not set. `AuthGuard` rejects. |
| Blacklisted token (post-logout) | `JwtMiddleware` checks blacklist; if blacklisted, does NOT set `req.user`. `AuthGuard` also checks and throws `TOKEN_REVOKED`. |
| Token missing jti (production) | Both `JwtMiddleware` and `AuthGuard` reject the token in production. |

### 4.2 Missing/Invalid Tenant ID

| Scenario | What happens |
|----------|-------------|
| No tenantId in JWT or header | Subgraph `TenantGuard` throws `BadRequestException('Tenant ID is required')`. |
| tenantId present but not a valid UUID | `TenantSchemaMiddleware` throws `BadRequestException('Invalid tenant ID format')`. `TenantGuard` also validates UUID format. |
| Valid UUID but schema does not exist | `TenantSchemaMiddleware` throws `UnauthorizedException('Tenant schema not found')`. No fallback to shared schema (D05-H1). |
| JWT tenantId mismatches header tenantId | At gateway: `AuthenticatedDataSource` forwards JWT tenantId (preferred). At subgraph: `TenantGuard.extractTenantId()` prefers `req.user.tenantId` over header. Mismatch blocked. |

### 4.3 Gateway Fails to Forward Headers

| Scenario | What happens |
|----------|-------------|
| `willSendRequest` skips context | Only for health checks and schema loading (`!context \|\| !('req' in context)`). |
| Header lost in transit | Subgraph `UserContextMiddleware` finds no `x-user-payload`, so `req.user` is null. `TenantGuard` requires tenantId from `req.user.tenantId` (priority 1). Request fails with 400. |

### 4.4 MFE Creates Its Own Client Without Tenant Headers

Multiple defense layers:

1. **Shared singleton:** All MFE modules import from `@aquaculture/shared-ui`
   (verified: farm, hr, sensor, hydroponics, dashboard, admin-panel, tenant-admin).
2. **Module Federation shared dependency:** `@aquaculture/shared-ui` is configured
   as `{ singleton: true, import: true }` in every MFE's vite.config.ts, so all
   remotes get the same instance with the same closure-scoped token.
3. **Window global fallback:** Even if a separate bundle copy loads,
   `getAccessToken()` / `getTenantId()` fall back to
   `window.__AQUACULTURE_AUTH__` (frozen, non-writable property -- SEC-016).
4. **AuthContext fail-closed:** If `useAuthContext()` is called outside
   `AuthProvider` (MFE loaded in isolation), it returns
   `isAuthenticated: false` and denies all access rather than attempting to
   decode an unverified JWT.
5. **sensor-module custom helpers:** The two `graphqlFetch` helpers in
   sensor-module use `getAccessToken()` + `getTenantId()` from shared-ui
   and explicitly set both headers.

### 4.5 Token Refresh Race Condition

**Mitigation:** `tokenRefreshPromise` is a module-level variable. Concurrent
401 retries coalesce on the same promise -- only one refresh mutation is sent.
After refresh, the new `accessToken` is stored in the closure and `tenantId` is
restored from the response (ARCH-AUTH-001).

### 4.6 Cross-Tenant Request Smuggling via X-Tenant-Id Header

**IMPORTANT FINDING:** The shared `TenantContextMiddleware` (used by BOTH
gateway and subgraphs) prioritizes the `x-tenant-id` header OVER the JWT
`req.user.tenantId`:

```typescript
// Priority order in TenantContextMiddleware.extractTenantContext():
// 1. req.headers['x-tenant-id']  <-- HEADER FIRST
// 2. req.user?.tenantId          <-- JWT second
// 3. req.query['tenantId']
// 4. subdomain
```

However, this is mitigated by two layers:

1. **Gateway forwarding:** `AuthenticatedDataSource.willSendRequest()` uses
   `req.user?.tenantId ?? req.headers['x-tenant-id']` -- so the JWT value
   OVERWRITES the header when forwarding to subgraphs. An attacker who sends
   a crafted `X-Tenant-Id` header has it replaced by the JWT's tenantId before
   it reaches any subgraph.

2. **Subgraph guard:** `TenantGuard.extractTenantId()` checks `req.user?.tenantId`
   FIRST (from x-user-payload), then compares against header/body/query sources.
   If they don't match, it throws `ForbiddenException('User does not belong to this tenant')`.

**Net effect:** Cross-tenant smuggling via X-Tenant-Id header is blocked, but the
priority order in `TenantContextMiddleware` is misleading. It would be more secure
to prioritize JWT over header at all layers for defense-in-depth.

### 4.7 Pool Connection Not Patched

| Scenario | What happens |
|----------|-------------|
| `TenantConnectionBootstrap` fails to find pg Pool | Logs error at startup: "Cannot patch connection pool -- pg Pool not found". All queries run on default search_path (`farm, public`), meaning all tenants write to the shared schema. **DATA LEAK.** |
| AsyncLocalStorage store missing (cron job, migration) | `getRequestContext()` returns `{}`, schemaName is undefined. Pool patch skips SET search_path. Query runs on default `farm, public` schema. This is correct for non-request contexts. |
| schemaName fails regex validation | `/^[a-z0-9_]+$/` rejects the value. search_path not set. Query runs on default schema. Safe but unexpected. |

### 4.8 TenantIsolationGuard Not Registered

**FINDING:** `TenantIsolationGuard` exists at
`apps/gateway-api/src/guards/tenant-isolation.guard.ts` with full cross-tenant
access validation, audit logging, and partner/reseller support. However, it is
**NOT** registered as an `APP_GUARD` in the gateway's `AppModule`. Only `AuthGuard`
and `RateLimitGuard` are registered.

**Impact:** The gateway does not enforce cross-tenant isolation at the guard level.
Isolation relies on:
- `AuthenticatedDataSource.willSendRequest()` preferring JWT tenantId
- Subgraph-level `TenantGuard` (registered in each service)
- `TenantSchemaMiddleware` in each service

This is adequate for current needs but leaves the gateway without a cross-tenant
defense layer. If a subgraph has a public endpoint or skips TenantGuard, the
gateway would forward the request without tenant validation.

---

## 5. Verification Checklist

### Per Frontend Module

| Check | dashboard | farm | hr | sensor | hydroponics | admin | tenant-admin |
|-------|:---------:|:----:|:--:|:------:|:-----------:|:-----:|:------------:|
| Uses shared `graphqlClient` or shared-ui token functions | Yes | Yes | Yes | Yes* | Yes | Yes | Yes* |
| JWT included in every request | Auto | Auto | Auto | Explicit | Auto | Auto | Explicit |
| X-Tenant-Id included in every request | Auto | Auto | Auto | Explicit | Auto | Auto | Explicit |
| No hardcoded tenant IDs | OK | OK | OK | OK | OK | OK | OK |
| No direct service calls bypassing gateway | OK | OK | OK | OK | OK | OK | OK |
| Wrapped in `ProtectedRoute` with role/module checks | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Module Federation singleton for shared-ui | Yes | Yes | Yes | Yes | Yes | Yes | N/A |

**"Auto"** = handled by the shared `GraphQLClient` class automatically.
**"Explicit"** = module has custom fetch helpers that manually set both headers
using `getAccessToken()` / `getTenantId()` from `@aquaculture/shared-ui`.
**"Yes*"** = uses custom fetch helper but correctly includes both headers.

### Per Backend Service

| Check | auth | farm | sensor | hr | hydroponics | ai | alert | billing | config |
|-------|:----:|:----:|:------:|:--:|:-----------:|:--:|:-----:|:-------:|:------:|
| Has `TenantSchemaMiddleware` | N/A | Yes | Yes | Yes | Yes | Yes | Verify | Verify | Verify |
| Has `TenantConnectionBootstrap` | N/A | Yes | Yes | Yes | Yes | Yes | Verify | Verify | Verify |
| UUID validation on tenantId | N/A | Yes | Yes | Yes | Yes | Yes | Verify | Verify | Verify |
| No fallback to shared schema (D05-H1) | N/A | Yes | Yes | Yes | Yes | Yes | Verify | Verify | Verify |
| search_path set via pool patch (not QueryRunner) | N/A | Yes | Yes | Yes | Yes | Yes | Verify | Verify | Verify |
| Has TenantGuard registered | N/A | Yes | Yes | Yes | Yes | Verify | Verify | Verify | Verify |
| Has RolesGuard registered | N/A | Yes | Yes | Yes | Yes | Verify | Verify | Verify | Verify |

**"N/A"** for auth-service because it operates on the `auth` schema (shared
across tenants) and uses tenant-scoped claims differently.

---

## 6. Differences from Previous Review

This section documents corrections from the previous version of this document:

1. **TenantContextMiddleware priority order:** Previous doc stated "prioritizes
   `req.user.tenantId` (from verified JWT) over the `X-Tenant-Id` header."
   **Incorrect.** The actual code at `libs/backend-common/src/middleware/tenant-context.middleware.ts`
   checks header FIRST (`req.headers['x-tenant-id']`), then JWT (`req.user?.tenantId`).
   Cross-tenant smuggling is prevented at other layers, not here.

2. **TenantIsolationGuard:** Previous doc listed it under gateway guards (step 5c).
   **Incorrect.** The guard class exists but is NOT registered as `APP_GUARD` in the
   gateway's `AppModule`. Only `AuthGuard` and `RateLimitGuard` are registered.

3. **Gateway context factory:** Previous doc said "context factory only passes
   `{ req, res }` through -- it never decodes JWT itself." **Correct**, but more
   precisely: the farm-service's GraphQL context factory DOES reconstruct `req.user`
   from `x-user-payload` / `x-user-id` / `x-user-roles` headers. This is separate
   from JWT verification.

4. **x-user-roles header format:** Previous doc did not specify the fallback.
   Actual code: `JSON.stringify(req.user.roles ?? [])` -- empty array fallback.

5. **Missing headers from willSendRequest:** Previous doc did not list
   `x-trace-id`, `x-span-id`, `x-parent-span-id`. These are forwarded.

6. **sensor-module client pattern:** Previous doc said all modules use the shared
   `graphqlClient`. Sensor-module actually has TWO custom `graphqlFetch()` helpers
   that bypass the shared client but correctly set both auth headers.

---

## 7. File Reference

| Layer | File |
|-------|------|
| Shell bootstrap | `web/shell/src/bootstrap.tsx` |
| Shell routing + ProtectedRoute | `web/shell/src/App.tsx` |
| AuthContext (login, JWT mgmt) | `web/shared-ui/src/contexts/AuthContext.tsx` |
| TenantContext (tenant state) | `web/shared-ui/src/contexts/TenantContext.tsx` |
| GraphQL + REST client | `web/shared-ui/src/utils/api-client.ts` |
| GraphQL utilities (React Query) | `web/shared-ui/src/utils/graphql-utils.ts` |
| useAuth hook | `web/shared-ui/src/hooks/useAuth.ts` |
| useTenant hook | `web/shared-ui/src/hooks/useTenant.ts` |
| useGraphQL hook | `web/shared-ui/src/hooks/useGraphQL.ts` |
| Sensor module API config | `web/modules/sensor-module/src/config/api.ts` |
| Sensor module custom graphqlFetch | `web/modules/sensor-module/src/hooks/useSensorRegistration.ts` |
| Tenant admin REST client | `web/modules/tenant-admin/src/services/tenantApi.ts` |
| HR module GraphQL wrapper | `web/modules/hr-module/src/hooks/useGraphQL.ts` |
| nginx config | `infrastructure/docker/nginx/nginx.prod.conf` |
| Gateway app module | `apps/gateway-api/src/app.module.ts` |
| Gateway JWT middleware | `apps/gateway-api/src/middleware/jwt.middleware.ts` |
| Gateway auth guard | `apps/gateway-api/src/guards/auth.guard.ts` |
| Gateway rate limit guard | `apps/gateway-api/src/guards/rate-limit.guard.ts` |
| Gateway tenant isolation guard (NOT registered) | `apps/gateway-api/src/guards/tenant-isolation.guard.ts` |
| Shared middleware (UserContext, TenantContext, Correlation, RequestLogging) | `libs/backend-common/src/middleware/tenant-context.middleware.ts` |
| Shared request context (AsyncLocalStorage) | `libs/backend-common/src/logging/request-context.ts` |
| Shared TenantGuard (subgraph level) | `libs/backend-common/src/guards/tenant.guard.ts` |
| Service tenant schema middleware (example) | `apps/farm-service/src/middleware/tenant-schema.middleware.ts` |
| Service connection bootstrap (example) | `apps/farm-service/src/infrastructure/tenant-connection-bootstrap.service.ts` |
| Service app module (example) | `apps/farm-service/src/app.module.ts` |
