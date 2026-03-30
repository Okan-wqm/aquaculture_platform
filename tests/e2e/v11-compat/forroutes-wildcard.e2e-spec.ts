/**
 * FIX-7: forRoutes('*') Wildcard Compatibility Verification Test
 *
 * BLOCKER for NestJS v11 upgrade (ADR-013).
 *
 * If Express v5's path-to-regexp v8 changes wildcard semantics,
 * forRoutes('*') silently stops matching routes. This breaks ALL
 * middleware applied via forRoutes('*') -- including tenant isolation
 * middleware (TenantContextMiddleware, TenantSchemaMiddleware),
 * which leads to silent tenant data leakage.
 *
 * This test verifies:
 *   1. forRoutes('*') applies middleware to all routes (current v10 baseline)
 *   2. forRoutes({ path: '*', method: RequestMethod.ALL }) works as fallback
 *   3. forRoutes({ path: '(.*)', method: RequestMethod.ALL }) does NOT work (documented)
 *   4. Middleware is applied to nested routes, not just root
 *   5. Multiple middleware in chain all execute via forRoutes('*')
 *   6. .exclude() + forRoutes('*') still works correctly
 *
 * Run: npx jest tests/e2e/v11-compat/forroutes-wildcard.e2e-spec.ts --config tests/e2e/v11-compat/jest.config.ts
 *
 * @see docs/architecture/ADR-013-nestjs-v11-upgrade.md section 4.2
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, RequestMethod } from '@nestjs/common';
import {
  Controller,
  Get,
  Injectable,
  MiddlewareConsumer,
  Module,
  NestMiddleware,
  NestModule,
} from '@nestjs/common';
import request from 'supertest';
import { Request, Response, NextFunction } from 'express';
import type { Server } from 'http';

// ---------------------------------------------------------------------------
// Test Middleware -- sets headers to prove it executed
// ---------------------------------------------------------------------------

const HEADER_WILDCARD = 'x-middleware-wildcard';
const HEADER_OBJECT_STAR = 'x-middleware-object-star';
const HEADER_OBJECT_REGEX = 'x-middleware-object-regex';
const HEADER_CHAIN_FIRST = 'x-chain-first';
const HEADER_CHAIN_SECOND = 'x-chain-second';
const HEADER_EXCLUDE_MARKER = 'x-exclude-marker';

@Injectable()
class WildcardMiddleware implements NestMiddleware {
  use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader(HEADER_WILDCARD, 'true');
    next();
  }
}

@Injectable()
class ObjectStarMiddleware implements NestMiddleware {
  use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader(HEADER_OBJECT_STAR, 'true');
    next();
  }
}

@Injectable()
class ObjectRegexMiddleware implements NestMiddleware {
  use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader(HEADER_OBJECT_REGEX, 'true');
    next();
  }
}

@Injectable()
class ChainFirstMiddleware implements NestMiddleware {
  use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader(HEADER_CHAIN_FIRST, 'true');
    next();
  }
}

@Injectable()
class ChainSecondMiddleware implements NestMiddleware {
  use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader(HEADER_CHAIN_SECOND, 'true');
    next();
  }
}

@Injectable()
class ExcludeMarkerMiddleware implements NestMiddleware {
  use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader(HEADER_EXCLUDE_MARKER, 'true');
    next();
  }
}

// ---------------------------------------------------------------------------
// Test Controllers
// ---------------------------------------------------------------------------

@Controller()
class RootController {
  @Get('test')
  getTest(): { status: string } {
    return { status: 'ok' };
  }

  @Get('nested/deep/route')
  getNestedRoute(): { status: string } {
    return { status: 'nested-ok' };
  }

  @Get('health')
  getHealth(): { status: string } {
    return { status: 'healthy' };
  }
}

// ---------------------------------------------------------------------------
// Test Modules -- each uses a different forRoutes pattern
// ---------------------------------------------------------------------------

@Module({ controllers: [RootController] })
class WildcardStringModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(WildcardMiddleware).forRoutes('*');
  }
}

@Module({ controllers: [RootController] })
class ObjectStarModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(ObjectStarMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}

@Module({ controllers: [RootController] })
class ObjectRegexModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(ObjectRegexMiddleware)
      .forRoutes({ path: '(.*)', method: RequestMethod.ALL });
  }
}

@Module({ controllers: [RootController] })
class ChainModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(ChainFirstMiddleware, ChainSecondMiddleware)
      .forRoutes('*');
  }
}

@Module({ controllers: [RootController] })
class ExcludeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(ExcludeMarkerMiddleware)
      .exclude('health', 'health/(.*)')
      .forRoutes('*');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModuleClass = new (...args: never[]) => NestModule;

async function createTestApp(moduleClass: ModuleClass): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [moduleClass],
  }).compile();

  const app = moduleFixture.createNestApplication();
  await app.init();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FIX-7: forRoutes wildcard compatibility', () => {
  // -----------------------------------------------------------------------
  // Suite 1: forRoutes('*') -- the pattern used in 12 production files
  // -----------------------------------------------------------------------
  describe('forRoutes("*") -- string wildcard (production pattern)', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createTestApp(WildcardStringModule);
    });

    afterAll(async () => {
      await app.close();
    });

    it('should apply middleware to a simple route', async () => {
      const response = await request(app.getHttpServer() as Server)
        .get('/test')
        .expect(200);

      expect(response.headers[HEADER_WILDCARD]).toBe('true');
    });

    it('should apply middleware to a nested route', async () => {
      const response = await request(app.getHttpServer() as Server)
        .get('/nested/deep/route')
        .expect(200);

      expect(response.headers[HEADER_WILDCARD]).toBe('true');
    });

    it('should apply middleware to the health route', async () => {
      const response = await request(app.getHttpServer() as Server)
        .get('/health')
        .expect(200);

      expect(response.headers[HEADER_WILDCARD]).toBe('true');
    });
  });

  // -----------------------------------------------------------------------
  // Suite 2: forRoutes({ path: '*', method: RequestMethod.ALL }) fallback
  // -----------------------------------------------------------------------
  describe('forRoutes({ path: "*", method: ALL }) -- object star fallback', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createTestApp(ObjectStarModule);
    });

    afterAll(async () => {
      await app.close();
    });

    it('should apply middleware to a simple route', async () => {
      const response = await request(app.getHttpServer() as Server)
        .get('/test')
        .expect(200);

      expect(response.headers[HEADER_OBJECT_STAR]).toBe('true');
    });

    it('should apply middleware to a nested route', async () => {
      const response = await request(app.getHttpServer() as Server)
        .get('/nested/deep/route')
        .expect(200);

      expect(response.headers[HEADER_OBJECT_STAR]).toBe('true');
    });
  });

  // -----------------------------------------------------------------------
  // Suite 3: forRoutes({ path: '(.*)', method: RequestMethod.ALL }) regex
  //
  // FINDING: On NestJS v10 + Express v4, the regex pattern '(.*)' does NOT
  // work as a wildcard for forRoutes. NestJS treats it as a literal path
  // prefix, so no routes match. This means '(.*)' is NOT a valid fallback.
  //
  // The ONLY valid patterns are:
  //   - forRoutes('*')                                  <-- production pattern
  //   - forRoutes({ path: '*', method: RequestMethod.ALL })  <-- object fallback
  //
  // If NestJS v11 breaks forRoutes('*'), the correct replacement is the
  // object form with path: '*', NOT a regex.
  // -----------------------------------------------------------------------
  describe('forRoutes({ path: "(.*)", method: ALL }) -- regex pattern (NOT a valid wildcard)', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createTestApp(ObjectRegexModule);
    });

    afterAll(async () => {
      await app.close();
    });

    it('should NOT apply middleware (regex is not treated as wildcard on v10)', async () => {
      const response = await request(app.getHttpServer() as Server)
        .get('/test')
        .expect(200);

      // On v10, '(.*)' does NOT match routes -- middleware is NOT applied
      expect(response.headers[HEADER_OBJECT_REGEX]).toBeUndefined();
    });

    it('should NOT apply middleware to nested routes either', async () => {
      const response = await request(app.getHttpServer() as Server)
        .get('/nested/deep/route')
        .expect(200);

      // Same: '(.*)' is not a valid wildcard pattern for forRoutes
      expect(response.headers[HEADER_OBJECT_REGEX]).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Suite 4: Multiple middleware in chain -- mirrors production pattern
  // e.g. auth-service applies 6 middleware via .apply(A, B, C...).forRoutes('*')
  // -----------------------------------------------------------------------
  describe('middleware chain via forRoutes("*")', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createTestApp(ChainModule);
    });

    afterAll(async () => {
      await app.close();
    });

    it('should execute all middleware in the chain on a simple route', async () => {
      const response = await request(app.getHttpServer() as Server)
        .get('/test')
        .expect(200);

      expect(response.headers[HEADER_CHAIN_FIRST]).toBe('true');
      expect(response.headers[HEADER_CHAIN_SECOND]).toBe('true');
    });

    it('should execute all middleware in the chain on a nested route', async () => {
      const response = await request(app.getHttpServer() as Server)
        .get('/nested/deep/route')
        .expect(200);

      expect(response.headers[HEADER_CHAIN_FIRST]).toBe('true');
      expect(response.headers[HEADER_CHAIN_SECOND]).toBe('true');
    });
  });

  // -----------------------------------------------------------------------
  // Suite 5: .exclude() + forRoutes('*') -- used by 4 services
  // (ai-service, hydroponics-service, messaging-service exclude 'health')
  // -----------------------------------------------------------------------
  describe('.exclude() with forRoutes("*")', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createTestApp(ExcludeModule);
    });

    afterAll(async () => {
      await app.close();
    });

    it('should apply middleware to non-excluded routes', async () => {
      const response = await request(app.getHttpServer() as Server)
        .get('/test')
        .expect(200);

      expect(response.headers[HEADER_EXCLUDE_MARKER]).toBe('true');
    });

    it('should NOT apply middleware to excluded /health route', async () => {
      const response = await request(app.getHttpServer() as Server)
        .get('/health')
        .expect(200);

      expect(response.headers[HEADER_EXCLUDE_MARKER]).toBeUndefined();
    });

    it('should apply middleware to nested routes (not excluded)', async () => {
      const response = await request(app.getHttpServer() as Server)
        .get('/nested/deep/route')
        .expect(200);

      expect(response.headers[HEADER_EXCLUDE_MARKER]).toBe('true');
    });
  });
});
