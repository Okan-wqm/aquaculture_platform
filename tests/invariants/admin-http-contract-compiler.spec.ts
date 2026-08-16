import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  analyzeAdminControllerSourceV1,
  analyzeAdminControllerSourceV2,
  canonicalAdminHttpContractJsonV1,
  canonicalAdminHttpContractJsonV2,
  canonicalAdminHttpContractTypeScriptV2,
  compileAdminHttpContractSourcesV1,
  compileAdminHttpContractSourcesV2,
  compileAdminHttpContractsV1,
  compileAdminHttpContractsV2,
} from '../../tools/codegen/admin-contracts/compiler';
import { ADMIN_HTTP_CONTRACT_DEBT_BASELINE_V1 } from '../../tools/codegen/admin-contracts/diagnostic-baseline.v2';
import {
  buildAdminHttpContractArtifactV2,
  canonicalAdminHttpContractArtifactJsonV2,
  createAdminHttpContractDebtBaselineV1,
} from '../../tools/codegen/admin-contracts/governance';

const REPO_ROOT = process.cwd();

describe('admin HTTP contract compiler', () => {
  it('detects mixed query authorities from syntax rather than source formatting', () => {
    const compilation = analyzeAdminControllerSourceV1(
      'fixture.controller.ts',
      `
        import { Controller, Get, Query as QueryValue } from '@nestjs/common';
        @Controller('fixtures')
        class FixtureController {
          @Get()
          async list(
            @QueryValue('status') status?: string,
            @QueryValue() page?: PageQueryDto,
          ): Promise<unknown> { return { status, page }; }
        }
      `,
    );

    expect(compilation.diagnostics).toEqual([
      expect.objectContaining({
        code: 'MIXED_QUERY_AUTHORITY',
        operationId: 'FixtureController.list',
      }),
    ]);
  });

  it('detects a static route declared after a matching parameter route', () => {
    const compilation = analyzeAdminControllerSourceV1(
      'fixture.controller.ts',
      `
        import { Controller, Get } from '@nestjs/common';
        @Controller('fixtures')
        class FixtureController {
          @Get(':id') byId(): void {}
          @Get('stats') stats(): void {}
        }
      `,
    );

    expect(compilation.diagnostics).toEqual([
      expect.objectContaining({
        code: 'STATIC_ROUTE_SHADOWED',
        operationId: 'FixtureController.stats',
      }),
    ]);
  });

  it('fails closed and deterministically on non-literal controller and handler routes', () => {
    const source = `
      import { Controller, Get } from '@nestjs/common';
      const controllerPath = 'fixtures';
      const handlerPath = 'list';
      @Controller(controllerPath)
      class DynamicControllerPath {
        @Get() list(): void {}
      }
      @Controller('fixtures')
      class DynamicHandlerPath {
        @Get(handlerPath) list(): void {}
      }
    `;
    const first = analyzeAdminControllerSourceV1('fixture.controller.ts', source);
    const second = analyzeAdminControllerSourceV1('fixture.controller.ts', source);

    expect(second).toEqual(first);
    expect(first.manifest.operations).toEqual([]);
    expect(first.diagnostics.map(({ code }) => code)).toEqual([
      'UNSUPPORTED_CONTROLLER_ROUTE_ARGUMENT',
      'UNSUPPORTED_HANDLER_ROUTE_ARGUMENT',
    ]);
  });

  it('diagnoses computed, property-based, and non-call handler decorators instead of skipping them', () => {
    const compilation = analyzeAdminControllerSourceV1(
      'fixture.controller.ts',
      `
        import { All, Controller, Delete, Get, Post } from '@nestjs/common';
        const handlerName = 'computed';
        @Controller('fixtures')
        class FixtureController {
          @Get('computed')
          [handlerName](): void {}

          @Post('property')
          propertyHandler = (): void => {};

          @Delete
          remove(): void {}

          @All('all-methods')
          allMethods(): void {}

          @Get('static')
          static staticHandler(): void {}

          @Get('declared')
          declaredHandler(): void;
          declaredHandler(): void {}
        }
      `,
    );

    expect(compilation.manifest.operations).toEqual([]);
    expect(compilation.diagnostics.map(({ code }) => code)).toEqual([
      'UNSUPPORTED_HANDLER_NAME',
      'UNSUPPORTED_HANDLER_DECLARATION',
      'UNSUPPORTED_HTTP_DECORATOR',
      'UNSUPPORTED_HTTP_DECORATOR',
      'UNSUPPORTED_HANDLER_DECLARATION',
      'UNSUPPORTED_HANDLER_DECLARATION',
    ]);
  });

  it('detects cross-file controller shadow conflicts and exact route collisions', () => {
    const shadow = compileAdminHttpContractSourcesV1([
      {
        file: 'dynamic.controller.ts',
        contents: `
          import { Controller, Get } from '@nestjs/common';
          @Controller('fixtures')
          class DynamicController { @Get(':id') byId(): void {} }
        `,
      },
      {
        file: 'static.controller.ts',
        contents: `
          import { Controller, Get } from '@nestjs/common';
          @Controller('fixtures')
          class StaticController { @Get('stats') stats(): void {} }
        `,
      },
    ]);
    const collision = compileAdminHttpContractSourcesV1([
      {
        file: 'first.controller.ts',
        contents: `
          import { Controller, Get } from '@nestjs/common';
          @Controller('fixtures')
          class FirstController { @Get('stats') stats(): void {} }
        `,
      },
      {
        file: 'second.controller.ts',
        contents: `
          import { Controller, Get } from '@nestjs/common';
          @Controller('fixtures')
          class SecondController { @Get('stats') stats(): void {} }
        `,
      },
    ]);

    expect(shadow.diagnostics).toEqual([
      expect.objectContaining({
        code: 'CROSS_CONTROLLER_STATIC_ROUTE_CONFLICT',
        operationId: 'StaticController.stats',
      }),
    ]);
    expect(collision.diagnostics).toEqual([
      expect.objectContaining({
        code: 'DUPLICATE_ROUTE',
        operationId: 'SecondController.stats',
      }),
    ]);
  });

  it('rejects a parameterized route that precedes a more specific overlapping pattern', () => {
    const compilation = analyzeAdminControllerSourceV1(
      'fixture.controller.ts',
      `
        import { Controller, Get } from '@nestjs/common';
        @Controller('fixtures')
        class FixtureController {
          @Get(':id/comments') comments(): void {}
          @Get('number/:value') byNumber(): void {}
        }
      `,
    );

    expect(compilation.diagnostics).toEqual([
      expect.objectContaining({
        code: 'STATIC_ROUTE_SHADOWED',
        operationId: 'FixtureController.byNumber',
      }),
    ]);
  });

  it('does not report route conflicts across HTTP methods, base paths, or route arities', () => {
    const compilation = compileAdminHttpContractSourcesV1([
      {
        file: 'dynamic.controller.ts',
        contents: `
          import { Controller, Get } from '@nestjs/common';
          @Controller('fixtures')
          class DynamicController { @Get(':id') byId(): void {} }
        `,
      },
      {
        file: 'non-conflicts.controller.ts',
        contents: `
          import { Controller, Get, Post } from '@nestjs/common';
          @Controller('fixtures')
          class DifferentMethodController { @Post('stats') stats(): void {} }
          @Controller('other')
          class DifferentBaseController { @Get('stats') stats(): void {} }
          @Controller('fixtures')
          class DifferentArityController { @Get('stats/details') stats(): void {} }
        `,
      },
    ]);

    expect(compilation.diagnostics).toEqual([]);
  });

  it('supports namespace-imported Nest decorators without weakening binding resolution', () => {
    const compilation = analyzeAdminControllerSourceV1(
      'fixture.controller.ts',
      `
        import * as Nest from '@nestjs/common';
        @Nest.Controller('fixtures')
        class FixtureController {
          @Nest.Get()
          list(@Nest.Query() query: PageQueryDto): void { void query; }
        }
      `,
    );

    expect(compilation.diagnostics).toEqual([]);
    expect(compilation.manifest.operations).toEqual([
      expect.objectContaining({
        operationId: 'FixtureController.list',
        path: '/fixtures',
        query: { namedKeys: [], wholeObjectDto: 'PageQueryDto' },
      }),
    ]);
  });

  it('fails closed when a controller source has no resolvable Nest controller authority', () => {
    const compilation = analyzeAdminControllerSourceV1(
      'fixture.controller.ts',
      `
        const Controller = (path: string) => path;
        @Controller('fixtures')
        class FixtureController {}
      `,
    );

    expect(compilation.diagnostics).toEqual([
      expect.objectContaining({ code: 'CONTROLLER_NOT_FOUND', operationId: '<source>' }),
    ]);
  });

  it('compiles every current controller without duplicate query mutation authority', () => {
    const compilation = compileAdminHttpContractsV1(REPO_ROOT);

    expect(compilation.manifest.operations.length).toBeGreaterThan(100);
    expect(compilation.diagnostics).toEqual([]);
  });

  it('emits byte-identical canonical JSON for the same source revision', () => {
    const first = canonicalAdminHttpContractJsonV1(compileAdminHttpContractsV1(REPO_ROOT));
    const second = canonicalAdminHttpContractJsonV1(compileAdminHttpContractsV1(REPO_ROOT));

    expect(second).toBe(first);
  });

  it('cannot serialize a partial manifest when diagnostics exist', () => {
    const invalid = analyzeAdminControllerSourceV1(
      'fixture.controller.ts',
      `
        import { Controller, Get } from '@nestjs/common';
        const path = 'dynamic';
        @Controller('fixtures')
        class FixtureController { @Get(path) list(): void {} }
      `,
    );

    expect(() => canonicalAdminHttpContractJsonV1(invalid)).toThrow(
      'Cannot serialize an admin HTTP contract with diagnostics',
    );
  });

  it('compiles a V2 operation graph with auth, path, query, body, response, and shape hashes', () => {
    const compilation = analyzeAdminControllerSourceV2(
      'fixture.controller.ts',
      `
        import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

        interface FixtureFilterDto {
          readonly page?: number;
          readonly status?: 'active' | 'paused';
        }

        interface CreateFixtureDto {
          readonly name: string;
          readonly tags: readonly string[];
        }

        interface FixtureViewV1 {
          readonly createdAt: Date;
          readonly id: string;
          readonly name: string;
        }

        @Controller('fixtures')
        class FixtureController {
          @Get(':id')
          async getById(
            @Param('id') id: string,
            @Query() query: FixtureFilterDto,
          ): Promise<FixtureViewV1> {
            throw new Error(id + String(query.page));
          }

          @Post()
          async create(@Body() body: CreateFixtureDto): Promise<FixtureViewV1> {
            throw new Error(body.name);
          }
        }
      `,
    );

    expect(compilation.diagnostics).toEqual([]);
    expect(compilation.coverage).toEqual({
      diagnosticCount: 0,
      discoveredOperationCount: 2,
      qualifiedOperationCount: 2,
      unqualifiedOperationCount: 0,
    });
    expect(compilation.manifest.schemaVersion).toBe(2);
    expect(compilation.manifest.operations).toHaveLength(2);
    expect(compilation.manifest.operations).toEqual([
      expect.objectContaining({
        auth: {
          guards: ['PlatformAdminGuard'],
          mode: 'BEARER_JWT',
          roles: ['SUPER_ADMIN'],
        },
        body: expect.objectContaining({
          required: true,
          type: expect.objectContaining({ name: 'CreateFixtureDto' }),
        }),
        contractHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        method: 'POST',
        operationId: 'FixtureController.create',
        parameters: [],
        path: '/fixtures',
        query: null,
        response: expect.objectContaining({
          kind: 'JSON',
          type: expect.objectContaining({ name: 'FixtureViewV1' }),
        }),
      }),
      expect.objectContaining({
        body: null,
        contractHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        method: 'GET',
        operationId: 'FixtureController.getById',
        parameters: [
          expect.objectContaining({
            name: 'id',
            required: true,
            type: expect.objectContaining({ name: 'string' }),
          }),
        ],
        path: '/fixtures/:id',
        query: expect.objectContaining({
          authority: 'OBJECT',
          type: expect.objectContaining({ name: 'FixtureFilterDto' }),
        }),
        response: expect.objectContaining({
          kind: 'JSON',
          type: expect.objectContaining({ name: 'FixtureViewV1' }),
        }),
      }),
    ]);
    expect(compilation.manifest.types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          shape: expect.objectContaining({
            kind: 'object',
            properties: expect.arrayContaining([
              expect.objectContaining({
                name: 'createdAt',
                shape: { kind: 'date-time' },
              }),
            ]),
          }),
          shapeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    );
  });

  it('fails V2 closed for anonymous, unresolved, and persistence-entity boundaries', () => {
    const compilation = analyzeAdminControllerSourceV2(
      'fixture.controller.ts',
      `
        import { Body, Controller, Get, Post } from '@nestjs/common';
        import { Entity, PrimaryGeneratedColumn } from 'typeorm';

        @Entity()
        class FixtureEntity {
          @PrimaryGeneratedColumn('uuid')
          id!: string;
        }

        @Controller('fixtures')
        class FixtureController {
          @Get('anonymous')
          anonymous(): Promise<{ readonly id: string }> { throw new Error(); }

          @Get('entity')
          entity(): Promise<ReadonlyArray<FixtureEntity>> { throw new Error(); }

          @Get('inferred')
          inferred() { return { id: 'fixture' }; }

          @Get('unknown')
          unknown(): Promise<unknown> { throw new Error(); }

          @Post('anonymous')
          anonymousBody(@Body() body: { readonly name: string }): Promise<string> {
            throw new Error(body.name);
          }

          @Post('entity')
          entityBody(@Body() body: Partial<FixtureEntity>): Promise<string> {
            throw new Error(String(body.id));
          }

          @Post('unknown')
          unknownBody(@Body() body: unknown): Promise<string> {
            throw new Error(String(body));
          }
        }
      `,
    );

    expect(compilation.manifest.operations).toEqual([]);
    expect(compilation.manifest.types).toEqual([]);
    expect(compilation.diagnostics.map(({ code }) => code)).toEqual([
      'ANONYMOUS_RESPONSE_TYPE',
      'ENTITY_RESPONSE_TYPE',
      'MISSING_RESPONSE_TYPE',
      'UNRESOLVED_RESPONSE_TYPE',
      'ANONYMOUS_BODY_TYPE',
      'ENTITY_BODY_TYPE',
      'UNRESOLVED_BODY_TYPE',
    ]);
    expect(() => canonicalAdminHttpContractJsonV2(compilation)).toThrow(
      'Cannot serialize an admin HTTP contract V2 with diagnostics',
    );
  });

  it('requires exact, non-optional path parameter authority in V2', () => {
    const compilation = analyzeAdminControllerSourceV2(
      'fixture.controller.ts',
      `
        import { Controller, Get, Param } from '@nestjs/common';
        interface FixtureViewV1 { readonly id: string; }
        @Controller('fixtures')
        class FixtureController {
          @Get(':id/:revision')
          get(
            @Param('id') id?: string,
            @Param('other') other: string = 'other',
          ): Promise<FixtureViewV1> { throw new Error(String(id) + other); }
        }
      `,
    );

    expect(compilation.manifest.operations).toEqual([]);
    expect(compilation.diagnostics.map(({ code }) => code)).toEqual([
      'MISSING_PATH_PARAMETER',
      'OPTIONAL_PATH_PARAMETER',
      'EXTRANEOUS_PATH_PARAMETER',
      'OPTIONAL_PATH_PARAMETER',
    ]);
  });

  it('derives trusted public and role metadata while rejecting lookalike auth decorators', () => {
    const valid = compileAdminHttpContractSourcesV2([
      {
        file: 'apps/admin-api-service/src/decorators/public.decorator.ts',
        contents: `export const Public = (): MethodDecorator => () => undefined;`,
      },
      {
        file: 'apps/admin-api-service/src/decorators/roles.decorator.ts',
        contents: `export const Roles = (...roles: string[]): MethodDecorator => () => { void roles; };`,
      },
      {
        file: 'apps/admin-api-service/src/fixture.controller.ts',
        contents: `
          import { Controller, Get } from '@nestjs/common';
          import { Public } from './decorators/public.decorator';
          import { Roles } from './decorators/roles.decorator';
          interface FixtureViewV1 { readonly id: string; }
          @Controller('fixtures')
          class FixtureController {
            @Get('public') @Public()
            publicView(): Promise<FixtureViewV1> { throw new Error(); }
            @Get('restricted') @Roles('SUPER_ADMIN')
            restrictedView(): Promise<FixtureViewV1> { throw new Error(); }
          }
        `,
      },
    ]);
    const lookalike = analyzeAdminControllerSourceV2(
      'lookalike.controller.ts',
      `
        import { Controller, Get } from '@nestjs/common';
        const Public = (): MethodDecorator => () => undefined;
        interface FixtureViewV1 { readonly id: string; }
        @Controller('fixtures')
        class FixtureController {
          @Get() @Public()
          get(): Promise<FixtureViewV1> { throw new Error(); }
        }
      `,
    );

    expect(valid.diagnostics).toEqual([]);
    expect(valid.manifest.operations.map(({ auth }) => auth)).toEqual([
      { guards: [], mode: 'PUBLIC', roles: [] },
      {
        guards: ['PlatformAdminGuard'],
        mode: 'BEARER_JWT',
        roles: ['SUPER_ADMIN'],
      },
    ]);
    expect(lookalike.diagnostics).toEqual([
      expect.objectContaining({ code: 'UNTRUSTED_AUTH_DECORATOR' }),
    ]);
    expect(lookalike.manifest.operations).toEqual([]);
  });

  it('emits byte-identical V2 JSON and zero-dependency TypeScript artifacts', () => {
    const sources = [
      {
        file: 'fixture.controller.ts',
        contents: `
          import { Controller, Get, Query } from '@nestjs/common';
          interface FixtureViewV1 { readonly id: string; readonly page: number; }
          @Controller('fixtures')
          class FixtureController {
            @Get()
            list(@Query('page') page: number): Promise<FixtureViewV1> {
              throw new Error(String(page));
            }
          }
        `,
      },
    ];
    const first = compileAdminHttpContractSourcesV2(sources);
    const second = compileAdminHttpContractSourcesV2(sources);

    expect(second).toEqual(first);
    expect(canonicalAdminHttpContractJsonV2(second)).toBe(canonicalAdminHttpContractJsonV2(first));
    expect(canonicalAdminHttpContractTypeScriptV2(first)).toBe(
      `export const adminHttpContractManifestV2 = ${canonicalAdminHttpContractJsonV2(first).trimEnd()} as const;\n`,
    );
    expect(canonicalAdminHttpContractTypeScriptV2(first)).not.toContain('import ');
  });

  it('changes both type and operation hashes when a wire shape changes', () => {
    const source = (extraProperty: string): string => `
      import { Controller, Get } from '@nestjs/common';
      interface FixtureViewV1 { readonly id: string; ${extraProperty} }
      @Controller('fixtures')
      class FixtureController {
        @Get()
        get(): Promise<FixtureViewV1> { throw new Error(); }
      }
    `;
    const first = analyzeAdminControllerSourceV2('fixture.controller.ts', source(''));
    const second = analyzeAdminControllerSourceV2(
      'fixture.controller.ts',
      source('readonly revision: number;'),
    );

    expect(first.diagnostics).toEqual([]);
    expect(second.diagnostics).toEqual([]);
    expect(first.manifest.operations[0]?.response).not.toEqual(
      second.manifest.operations[0]?.response,
    );
    expect(first.manifest.operations[0]?.contractHash).not.toBe(
      second.manifest.operations[0]?.contractHash,
    );
  });

  it('blocks contract publication behind exact, expiring diagnostic evidence', () => {
    const first = analyzeAdminControllerSourceV2(
      'fixture.controller.ts',
      `
        import { Controller, Get } from '@nestjs/common';
        @Controller('fixtures')
        class FixtureController {
          @Get() get() { return { id: 'fixture' }; }
        }
      `,
    );
    const baseline = createAdminHttpContractDebtBaselineV1(first, {
      basedOnMainSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      expiresOn: '2026-08-22',
      findingId: 'ADMIN-HIGH-004',
      owner: 'admin-expert',
    });

    expect(buildAdminHttpContractArtifactV2(first, baseline, '2026-08-22')).toEqual(
      expect.objectContaining({
        contract: null,
        diagnosticDebt: expect.objectContaining({
          baselineContentSha256: baseline.contentSha256,
          diagnostics: [{ code: 'MISSING_RESPONSE_TYPE', count: 1 }],
        }),
        status: 'BLOCKED',
      }),
    );
    expect(() => buildAdminHttpContractArtifactV2(first, baseline, '2026-08-23')).toThrow(
      'Admin HTTP contract debt baseline expired on 2026-08-22',
    );

    const changedSource = analyzeAdminControllerSourceV2(
      'fixture.controller.ts',
      `
        import { Controller, Get } from '@nestjs/common';
        @Controller('fixtures')
        class FixtureController {
          @Get() get() { return { id: 'changed' }; }
        }
      `,
    );
    expect(() => buildAdminHttpContractArtifactV2(changedSource, baseline, '2026-08-22')).toThrow(
      'Admin HTTP contract diagnostic drift',
    );
  });

  it('publishes a contract only when every discovered operation is qualified', () => {
    const compilation = analyzeAdminControllerSourceV2(
      'fixture.controller.ts',
      `
        import { Controller, Get } from '@nestjs/common';
        interface FixtureViewV1 { readonly id: string; }
        @Controller('fixtures')
        class FixtureController {
          @Get() get(): Promise<FixtureViewV1> { throw new Error(); }
        }
      `,
    );

    expect(buildAdminHttpContractArtifactV2(compilation, null, '2026-08-22')).toEqual(
      expect.objectContaining({
        contract: compilation.manifest,
        diagnosticDebt: null,
        status: 'QUALIFIED',
      }),
    );
    expect(
      JSON.parse(canonicalAdminHttpContractArtifactJsonV2(compilation, null, '2026-08-22')),
    ).toEqual(buildAdminHttpContractArtifactV2(compilation, null, '2026-08-22'));
    const staleBaseline = createAdminHttpContractDebtBaselineV1(
      analyzeAdminControllerSourceV2(
        'invalid.controller.ts',
        `
          import { Controller, Get } from '@nestjs/common';
          @Controller('invalid') class InvalidController { @Get() get() { return {}; } }
        `,
      ),
      {
        basedOnMainSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        expiresOn: '2026-08-22',
        findingId: 'ADMIN-HIGH-004',
        owner: 'admin-expert',
      },
    );
    expect(() =>
      buildAdminHttpContractArtifactV2(compilation, staleBaseline, '2026-08-22'),
    ).toThrow('remove the admin HTTP contract debt baseline');
  });

  it('pins the current incomplete surface without exposing a partial contract', () => {
    const compilation = compileAdminHttpContractsV2(REPO_ROOT);
    const artifact = canonicalAdminHttpContractArtifactJsonV2(
      compilation,
      ADMIN_HTTP_CONTRACT_DEBT_BASELINE_V1,
      new Date().toISOString().slice(0, 10),
    );
    const artifactPath = join(
      REPO_ROOT,
      'platform/libs/admin-http-contracts/src/generated/admin-http-contract-compilation.v2.json',
    );

    expect(compilation.coverage).toEqual(ADMIN_HTTP_CONTRACT_DEBT_BASELINE_V1.coverage);
    expect(JSON.parse(artifact)).toEqual(
      expect.objectContaining({ contract: null, status: 'BLOCKED' }),
    );
    expect(readFileSync(artifactPath, 'utf8')).toBe(artifact);
  });
});
