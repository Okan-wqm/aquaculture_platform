# Agent 4: Gateway Security Architect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Secure AI proxy, add CSRF protection, fix federation config, expand health checks, enforce service secret, fix mutation rate limiting, strip x-user-payload from external requests.

**Architecture:** Replace open AI proxy with allowlisted header/path proxy + circuit breaker. Add double-submit cookie CSRF. Remove dead notification subgraph. Expand health checks. Parse GraphQL AST for mutation-level rate limiting.

**Tech Stack:** NestJS, Apollo Federation, Express, graphql (AST parsing), ioredis

**Owned files:** All files in `apps/gateway-api/src/`

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `apps/gateway-api/src/routes/v2/ai.routes.ts` | Secure proxy — header allowlist, path validation, circuit breaker |
| Create | `apps/gateway-api/src/middleware/csrf.middleware.ts` | CSRF double-submit cookie |
| Create | `apps/gateway-api/src/middleware/csrf.middleware.spec.ts` | Tests |
| Modify | `apps/gateway-api/src/app.module.ts` | Remove notification subgraph, register CSRF, strip x-user-payload |
| Modify | `apps/gateway-api/src/health/health.service.ts` | Add hydroponics + config services |
| Modify | `apps/gateway-api/src/main.ts` | Hard-fail on missing INTERNAL_SERVICE_SECRET |
| Create | `apps/gateway-api/src/guards/mutation-rate-limit.guard.ts` | AST-based mutation rate limiting |
| Modify | `apps/gateway-api/src/middleware/jwt.middleware.ts` | Strip x-user-payload from external requests |

---

### Task 1: Secure AI Proxy

**Files:**
- Modify: `apps/gateway-api/src/routes/v2/ai.routes.ts`

- [ ] **Step 1: Read current AI proxy implementation**

Read: `apps/gateway-api/src/routes/v2/ai.routes.ts`

- [ ] **Step 2: Replace with secured proxy**

```typescript
import { Controller, All, Req, Res, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';

const ALLOWED_HEADERS = [
  'authorization',
  'content-type',
  'accept',
  'x-correlation-id',
  'x-tenant-id',
];

const FORBIDDEN_PATH_PATTERNS = [
  /\.\./,      // path traversal
  /\/\//,      // double slash
  /[;\|&`$]/,  // command injection chars
];

// Simple circuit breaker
class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private readonly threshold: number = 3,
    private readonly resetTimeMs: number = 30000,
  ) {}

  canRequest(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.resetTimeMs) {
        this.state = 'half-open';
        return true;
      }
      return false;
    }
    return true; // half-open: allow one request
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'open';
    }
  }
}

@Controller('api/v2/ai')
export class AiRoutesController {
  private readonly logger = new Logger(AiRoutesController.name);
  private readonly circuitBreaker = new CircuitBreaker(3, 30000);
  private readonly aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:3010';

  @All('*')
  async proxy(@Req() req: Request, @Res() res: Response): Promise<void> {
    // Circuit breaker check
    if (!this.circuitBreaker.canRequest()) {
      throw new HttpException('AI service temporarily unavailable', HttpStatus.SERVICE_UNAVAILABLE);
    }

    // Path validation
    const targetPath = req.originalUrl.replace('/api/v2/ai', '');
    for (const pattern of FORBIDDEN_PATH_PATTERNS) {
      if (pattern.test(targetPath)) {
        throw new HttpException('Invalid request path', HttpStatus.BAD_REQUEST);
      }
    }

    // Header allowlist — only forward safe headers
    const forwardHeaders: Record<string, string> = {};
    for (const header of ALLOWED_HEADERS) {
      if (req.headers[header]) {
        forwardHeaders[header] = req.headers[header] as string;
      }
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(`${this.aiServiceUrl}${targetPath}`, {
        method: req.method,
        headers: forwardHeaders,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      this.circuitBreaker.recordSuccess();

      res.status(response.status);
      const data = await response.text();
      res.send(data);
    } catch (error) {
      this.circuitBreaker.recordFailure();
      if (error.name === 'AbortError') {
        throw new HttpException('AI service request timeout', HttpStatus.GATEWAY_TIMEOUT);
      }
      throw new HttpException('AI service unavailable', HttpStatus.BAD_GATEWAY);
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/gateway-api/src/routes/v2/ai.routes.ts
git commit -m "fix(gateway): secure AI proxy — header allowlist, path validation, circuit breaker, 30s timeout"
```

---

### Task 2: CSRF Protection

**Files:**
- Create: `apps/gateway-api/src/middleware/csrf.middleware.ts`
- Create: `apps/gateway-api/src/middleware/csrf.middleware.spec.ts`

- [ ] **Step 1: Write failing test**

```typescript
// apps/gateway-api/src/middleware/csrf.middleware.spec.ts
import { CsrfMiddleware } from './csrf.middleware';

describe('CsrfMiddleware', () => {
  let middleware: CsrfMiddleware;

  beforeEach(() => {
    middleware = new CsrfMiddleware();
  });

  it('should skip GET requests', () => {
    const req = { method: 'GET', cookies: {}, headers: {} } as any;
    const res = { cookie: jest.fn() } as any;
    const next = jest.fn();

    middleware.use(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('should reject POST without CSRF token', () => {
    const req = {
      method: 'POST',
      path: '/graphql',
      cookies: { 'csrf-token': 'abc123' },
      headers: {},
    } as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const next = jest.fn();

    middleware.use(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should accept POST with matching CSRF cookie and header', () => {
    const token = 'valid-csrf-token';
    const req = {
      method: 'POST',
      path: '/graphql',
      cookies: { 'csrf-token': token },
      headers: { 'x-csrf-token': token },
    } as any;
    const res = { cookie: jest.fn() } as any;
    const next = jest.fn();

    middleware.use(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement CSRF middleware**

```typescript
// apps/gateway-api/src/middleware/csrf.middleware.ts
import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const CSRF_COOKIE = 'csrf-token';
const CSRF_HEADER = 'x-csrf-token';

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CsrfMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    // Safe methods don't need CSRF protection
    if (SAFE_METHODS.includes(req.method)) {
      // Set CSRF cookie on safe requests so client can read it
      if (!req.cookies?.[CSRF_COOKIE]) {
        const token = randomBytes(32).toString('hex');
        res.cookie(CSRF_COOKIE, token, {
          httpOnly: false, // Client JS must read this
          sameSite: 'strict',
          secure: process.env.NODE_ENV === 'production',
          path: '/',
        });
      }
      return next();
    }

    // State-changing methods require CSRF validation
    const cookieToken = req.cookies?.[CSRF_COOKIE];
    const headerToken = req.headers[CSRF_HEADER] as string;

    if (!cookieToken || !headerToken) {
      this.logger.warn(`CSRF validation failed: missing tokens. Path: ${req.path}`);
      res.status(403).json({
        statusCode: 403,
        message: 'CSRF token missing',
        error: 'Forbidden',
      });
      return;
    }

    if (cookieToken !== headerToken) {
      this.logger.warn(`CSRF validation failed: token mismatch. Path: ${req.path}`);
      res.status(403).json({
        statusCode: 403,
        message: 'CSRF token mismatch',
        error: 'Forbidden',
      });
      return;
    }

    next();
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx jest apps/gateway-api/src/middleware/csrf.middleware.spec.ts --no-coverage`
Expected: PASS

- [ ] **Step 4: Register in app.module.ts and commit**

```bash
git add apps/gateway-api/src/middleware/csrf.middleware.ts \
        apps/gateway-api/src/middleware/csrf.middleware.spec.ts \
        apps/gateway-api/src/app.module.ts
git commit -m "feat(gateway): add CSRF double-submit cookie protection for state-changing requests"
```

---

### Task 3: Fix Federation Config + Health Checks

**Files:**
- Modify: `apps/gateway-api/src/app.module.ts`
- Modify: `apps/gateway-api/src/health/health.service.ts`

- [ ] **Step 1: Read federation config**

Read: `apps/gateway-api/src/app.module.ts:310-360` (subgraphs list)

- [ ] **Step 2: Remove notification subgraph from federation**

Find the notification entry in the subgraphs array and remove it. notification-service is event-driven and does not expose GraphQL.

- [ ] **Step 3: Add hydroponics + config to health checks**

Read: `apps/gateway-api/src/health/health.service.ts`

Add hydroponics and config service URLs to the health check list:

```typescript
// Add to the services array:
{ name: 'hydroponics', url: process.env.HYDROPONICS_SERVICE_URL || 'http://localhost:4007' },
{ name: 'config', url: process.env.CONFIG_SERVICE_URL || 'http://localhost:3007' },
```

- [ ] **Step 4: Commit**

```bash
git add apps/gateway-api/src/app.module.ts apps/gateway-api/src/health/health.service.ts
git commit -m "fix(gateway): remove notification subgraph, add hydroponics+config to health checks"
```

---

### Task 4: Hard-Fail on Missing INTERNAL_SERVICE_SECRET

**Files:**
- Modify: `apps/gateway-api/src/main.ts`

- [ ] **Step 1: Read main.ts startup**

Read: `apps/gateway-api/src/main.ts:1-50`

- [ ] **Step 2: Add hard-fail check**

```typescript
// Add after app creation, before listen:
if (process.env.NODE_ENV === 'production' && !process.env.INTERNAL_SERVICE_SECRET) {
  throw new Error(
    'FATAL: INTERNAL_SERVICE_SECRET is required in production. ' +
    'This secret authenticates inter-service communication. ' +
    'Without it, the x-user-payload header can be spoofed by external clients.',
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/gateway-api/src/main.ts
git commit -m "fix(gateway): hard-fail on missing INTERNAL_SERVICE_SECRET in production"
```

---

### Task 5: Strip x-user-payload from External Requests

**Files:**
- Modify: `apps/gateway-api/src/app.module.ts` (middleware chain)

- [ ] **Step 1: Add header stripping in middleware chain**

In the middleware configuration (where `JwtMiddleware` is applied), add before the JWT middleware:

```typescript
// Strip x-user-payload from ALL incoming external requests
// This header should only be set by the gateway itself when forwarding to subgraphs
consumer
  .apply((req: Request, res: Response, next: NextFunction) => {
    // Only internal services with valid HMAC signature can send x-user-payload
    const serviceIdentity = req.headers['x-service-identity'];
    const serviceSignature = req.headers['x-service-signature'];

    if (!serviceIdentity || !serviceSignature) {
      // External request — strip trusted internal headers
      delete req.headers['x-user-payload'];
      delete req.headers['x-user-id'];
      delete req.headers['x-user-roles'];
    }
    next();
  })
  .forRoutes('*');
```

- [ ] **Step 2: Commit**

```bash
git add apps/gateway-api/src/app.module.ts
git commit -m "fix(gateway): strip x-user-payload from external requests — prevent identity spoofing"
```

---

### Task 6: GraphQL Mutation Rate Limiting by AST

**Files:**
- Create: `apps/gateway-api/src/guards/mutation-rate-limit.guard.ts`

- [ ] **Step 1: Implement AST-based mutation detection**

```typescript
// apps/gateway-api/src/guards/mutation-rate-limit.guard.ts
import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { parse, OperationDefinitionNode } from 'graphql';

@Injectable()
export class MutationRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(MutationRateLimitGuard.name);
  private readonly mutationCounts = new Map<string, { count: number; resetAt: number }>();
  private readonly limit = parseInt(process.env.MUTATION_RATE_LIMIT || '30', 10);
  private readonly windowMs = 60000; // 1 minute

  canActivate(context: ExecutionContext): boolean {
    const gqlContext = GqlExecutionContext.create(context);
    const info = gqlContext.getInfo();

    // Only rate-limit mutations
    if (info?.operation?.operation !== 'mutation') {
      return true;
    }

    const req = gqlContext.getContext().req;
    const key = `mutation:${req.user?.sub || req.ip}`;
    const now = Date.now();

    const entry = this.mutationCounts.get(key);
    if (!entry || now > entry.resetAt) {
      this.mutationCounts.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    entry.count++;
    if (entry.count > this.limit) {
      this.logger.warn(`Mutation rate limit exceeded for ${key}: ${entry.count}/${this.limit}`);
      return false;
    }

    return true;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/gateway-api/src/guards/mutation-rate-limit.guard.ts
git commit -m "feat(gateway): add GraphQL mutation rate limiting by operation type"
```

---

### Task 7: Discovery Pass

- [ ] **Step 1: Scan all owned files for additional issues**
- [ ] **Step 2: Log discoveries to DISCOVERY_LOG.md**
- [ ] **Step 3: Fix CRIT/HIGH within scope**
- [ ] **Step 4: Final commit**
