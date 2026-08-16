import {
  Body,
  Controller,
  Get,
  Headers,
  type INestApplication,
  Param,
  Post,
  Query,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  adminResponse,
  createAdminRequestContract,
  type AdminServerRequestContractCatalogV1,
} from '@platform/admin-http-contracts';
import { IsString, MaxLength } from 'class-validator';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

import { createAdminRequestContractGuard } from './admin-request-contract.guard';

class RuntimeValidatedBody {
  @IsString()
  @MaxLength(3)
  name!: string;
}

interface RuntimeErasedBody {
  readonly at: string;
  readonly state: 'OPEN' | 'CLOSED';
  readonly nested: { readonly enabled: boolean };
}

@Controller('boundary-fixture')
class BoundaryFixtureController {
  @Get()
  root(): Readonly<Record<string, unknown>> {
    return { root: true };
  }

  @Post('class')
  classBody(@Body() body: RuntimeValidatedBody): Readonly<Record<string, unknown>> {
    return { name: body.name, transformedByValidationPipe: body instanceof RuntimeValidatedBody };
  }

  @Post('erased')
  erasedBody(@Body() body: RuntimeErasedBody): Readonly<Record<string, unknown>> {
    return {
      state: body.state,
      nullPrototype: Object.getPrototypeOf(body) === null,
      frozen: Object.isFrozen(body),
    };
  }

  @Get('items/:id')
  item(
    @Param('id') id: string,
    @Query() query: { readonly limit: number; readonly state?: 'OPEN' | 'CLOSED' },
    @Headers('x-fixture') fixture: string,
  ): Readonly<Record<string, unknown>> {
    return { id, limit: query.limit, state: query.state, fixture };
  }

  @Get('other')
  other(@Headers('x-other') value?: string): Readonly<Record<string, unknown>> {
    return { value };
  }

  @Get('uncovered')
  uncovered(): Readonly<Record<string, unknown>> {
    return { reached: true };
  }

  @Get('lifecycle/internal')
  internal(): Readonly<Record<string, unknown>> {
    return { internal: true };
  }
}

const EMPTY_REQUEST_OBJECT = adminResponse.object({});

const REQUEST_CATALOG: AdminServerRequestContractCatalogV1 = Object.freeze({
  'GET /boundary-fixture': createAdminRequestContract(
    EMPTY_REQUEST_OBJECT,
    EMPTY_REQUEST_OBJECT,
    {},
    EMPTY_REQUEST_OBJECT,
    adminResponse.void(),
    null,
  ),
  'POST /boundary-fixture/class': createAdminRequestContract(
    EMPTY_REQUEST_OBJECT,
    EMPTY_REQUEST_OBJECT,
    {},
    EMPTY_REQUEST_OBJECT,
    adminResponse.object({ name: adminResponse.string() }),
    'application/json',
  ),
  'POST /boundary-fixture/erased': createAdminRequestContract(
    EMPTY_REQUEST_OBJECT,
    EMPTY_REQUEST_OBJECT,
    {},
    EMPTY_REQUEST_OBJECT,
    adminResponse.object({
      at: adminResponse.dateString(),
      state: adminResponse.literalSet(['OPEN', 'CLOSED'] as const),
      nested: adminResponse.object({ enabled: adminResponse.boolean() }),
    }),
    'application/json',
  ),
  'GET /boundary-fixture/items/:id': createAdminRequestContract(
    adminResponse.object({ id: adminResponse.string() }),
    adminResponse.object({
      limit: adminResponse.number(),
      state: adminResponse.optional(adminResponse.literalSet(['OPEN', 'CLOSED'] as const)),
    }),
    { limit: 'scalar', state: 'scalar' },
    adminResponse.object({ 'x-fixture': adminResponse.string() }),
    adminResponse.void(),
    null,
  ),
  'GET /boundary-fixture/other': createAdminRequestContract(
    EMPTY_REQUEST_OBJECT,
    EMPTY_REQUEST_OBJECT,
    {},
    adminResponse.object({ 'x-other': adminResponse.optional(adminResponse.string()) }),
    adminResponse.void(),
    null,
  ),
  'GET /boundary-fixture/lifecycle/internal': createAdminRequestContract(
    EMPTY_REQUEST_OBJECT,
    EMPTY_REQUEST_OBJECT,
    {},
    adminResponse.object({ 'x-fixture': adminResponse.optional(adminResponse.string()) }),
    adminResponse.void(),
    null,
  ),
});

const REQUEST_LIFECYCLE = Object.freeze({
  'GET /boundary-fixture': 'ACTIVE',
  'POST /boundary-fixture/class': 'ACTIVE',
  'POST /boundary-fixture/erased': 'ACTIVE',
  'GET /boundary-fixture/items/:id': 'ACTIVE',
  'GET /boundary-fixture/other': 'ACTIVE',
  'GET /boundary-fixture/lifecycle/internal': 'INTERNAL_GATEWAY_ONLY',
} as const);

describe('generated admin request controller boundary', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BoundaryFixtureController],
    }).compile();
    app = module.createNestApplication();
    app.use(
      (
        req: Request & {
          verifiedIdentity?: { readonly serviceName: string; readonly audience: string };
        },
        _res: Response,
        next: NextFunction,
      ): void => {
        if (req.headers['x-fixture'] === 'verified-gateway') {
          req.verifiedIdentity = {
            serviceName: 'gateway-api',
            audience: 'admin-api-service',
          };
        }
        next();
      },
    );
    app.useGlobalGuards(createAdminRequestContractGuard(REQUEST_CATALOG, REQUEST_LIFECYCLE));
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs the generated decoder and then class-validator exactly once', async () => {
    await request(app.getHttpServer())
      .post('/boundary-fixture/class')
      .send({ name: 'ok' })
      .expect(201)
      .expect({ name: 'ok', transformedByValidationPipe: true });

    await request(app.getHttpServer())
      .post('/boundary-fixture/class')
      .send({ name: 'long' })
      .expect(400);
  });

  it('maps Nest parameterless handler metadata to the compiled base-route identity', async () => {
    await request(app.getHttpServer()).get('/boundary-fixture').expect(200).expect({ root: true });
  });

  it('gives a runtime-erased interface the same generated fail-closed boundary', async () => {
    await request(app.getHttpServer())
      .post('/boundary-fixture/erased')
      .send({
        at: '2026-08-09T00:00:00.000Z',
        state: 'OPEN',
        nested: { enabled: true },
      })
      .expect(201)
      .expect({ state: 'OPEN', nullPrototype: true, frozen: true });

    await request(app.getHttpServer())
      .post('/boundary-fixture/erased')
      .send({
        at: '2026-08-09T00:00:00.000Z',
        state: 'INJECTED',
        nested: { enabled: true },
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/boundary-fixture/erased')
      .send({
        at: '2026-08-09T00:00:00.000Z',
        state: 'OPEN',
        nested: { enabled: true, injected: true },
      })
      .expect(400);
  });

  it('canonically decodes path, query, enum and named header inputs', async () => {
    await request(app.getHttpServer())
      .get('/boundary-fixture/items/item-1?limit=25&state=CLOSED')
      .set('x-fixture', 'fixture-1')
      .expect(200)
      .expect({ id: 'item-1', limit: 25, state: 'CLOSED', fixture: 'fixture-1' });

    await request(app.getHttpServer())
      .get('/boundary-fixture/items/item-1?limit=25&state=INJECTED')
      .set('x-fixture', 'fixture-1')
      .expect(400);

    await request(app.getHttpServer())
      .get('/boundary-fixture/items/item-1?limit=25&unknown=true')
      .set('x-fixture', 'fixture-1')
      .expect(400);
  });

  it('rejects a caller header owned by another route', async () => {
    await request(app.getHttpServer())
      .get('/boundary-fixture/items/item-1?limit=25')
      .set('x-fixture', 'fixture-1')
      .set('x-other', 'cross-route')
      .expect(400);
  });

  it('rejects a non-transport header even when no other route owns its name', async () => {
    await request(app.getHttpServer())
      .get('/boundary-fixture/items/item-1?limit=25')
      .set('x-fixture', 'fixture-1')
      .set('x-injected', 'undeclared')
      .expect(400);
  });

  it('fails closed when a Nest handler is absent from the generated catalog', async () => {
    await request(app.getHttpServer()).get('/boundary-fixture/uncovered').expect(503);
  });

  it('requires a verified gateway identity for internal-only routes', async () => {
    await request(app.getHttpServer()).get('/boundary-fixture/lifecycle/internal').expect(403);

    await request(app.getHttpServer())
      .get('/boundary-fixture/lifecycle/internal')
      .set('x-fixture', 'verified-gateway')
      .expect(200)
      .expect({ internal: true });
  });

  it('rejects a lifecycle projection that does not exactly cover the request catalog', () => {
    expect(() =>
      createAdminRequestContractGuard(
        REQUEST_CATALOG,
        Object.freeze({ 'GET /boundary-fixture': 'ACTIVE' as const }),
      ),
    ).toThrow('admin route lifecycle catalog must exactly cover generated routes');
  });
});
