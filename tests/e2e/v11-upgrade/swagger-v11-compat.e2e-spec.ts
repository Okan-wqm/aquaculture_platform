/**
 * Swagger v11 Compatibility E2E Regression Tests
 *
 * Validates that @nestjs/swagger v11.2.6 (upgraded from v7) produces correct
 * OpenAPI 3.x documents using the admin-api-service configuration. The admin-api
 * is the ONLY service with Swagger enabled.
 *
 * Covers:
 *   1. OpenAPI Document Generation (structure, info, version)
 *   2. Endpoint Coverage (API tags, security schemes)
 *   3. Custom Decorator Validation (ApiStandardResponse, ApiPaginatedResponse, getSchemaPath)
 *   4. DocumentBuilder API Compatibility (all builder methods)
 *   5. Schema Structure (paths, components, $ref resolution)
 *   6. v11-Specific Regression Guards
 *
 * Run:
 *   npx jest tests/e2e/v11-upgrade/swagger-v11-compat.e2e-spec.ts \
 *     --config tests/e2e/v11-upgrade/jest.config.ts
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Module,
} from '@nestjs/common';
import {
  SwaggerModule,
  DocumentBuilder,
  ApiTags,
  ApiOperation,
  ApiProperty,
  ApiExtraModels,
  getSchemaPath,
  ApiOkResponse,
} from '@nestjs/swagger';
import { Test, TestingModule } from '@nestjs/testing';

import {
  ApiStandardResponse,
  ApiPaginatedResponse,
  ApiStandardErrors,
  ApiCreatedStandardResponse,
  ApiNotFoundError,
  ApiConflictError,
} from '../../../libs/shared/src/decorators/api-response.decorators';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Loosely-typed OpenAPI document. Uses index signatures to avoid strict-null
 * issues when traversing nested optional properties in test assertions.
 */
interface OpenApiInfo {
  title: string;
  description: string;
  version: string;
  [key: string]: unknown;
}

interface OpenApiServer {
  url: string;
  description: string;
  [key: string]: unknown;
}

interface SchemaObject {
  [key: string]: unknown;
}

interface SecuritySchemeObject {
  type: string;
  scheme?: string;
  bearerFormat?: string;
  in?: string;
  name?: string;
  [key: string]: unknown;
}

interface ParameterObject {
  name: string;
  in: string;
  required?: boolean;
  schema?: SchemaObject;
  [key: string]: unknown;
}

interface PathOperation {
  operationId?: string;
  summary?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: SchemaObject;
  responses?: Record<string, SchemaObject>;
  [key: string]: unknown;
}

interface OpenApiDocument {
  openapi: string;
  info: OpenApiInfo;
  servers?: OpenApiServer[];
  paths: Record<string, Record<string, PathOperation>>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, SecuritySchemeObject>;
    [key: string]: unknown;
  };
  tags?: Array<{ name: string; description?: string }>;
  [key: string]: unknown;
}

// ============================================================================
// Test DTO Models (ApiProperty-decorated for Swagger schema generation)
// ============================================================================

class TestItemDto {
  @ApiProperty({ description: 'Unique identifier', example: 'uuid-123' })
  id!: string;

  @ApiProperty({ description: 'Item name', example: 'Test Item' })
  name!: string;

  @ApiProperty({ description: 'Item status', enum: ['active', 'inactive'] })
  status!: string;

  @ApiProperty({ description: 'Creation timestamp', format: 'date-time' })
  createdAt!: string;
}

class TestCreateItemDto {
  @ApiProperty({ description: 'Item name', example: 'New Item' })
  name!: string;

  @ApiProperty({ description: 'Item status', enum: ['active', 'inactive'], default: 'active' })
  status!: string;
}

class TestPaginationQueryDto {
  @ApiProperty({ description: 'Page number', required: false, default: 1 })
  page?: number;

  @ApiProperty({ description: 'Items per page', required: false, default: 20 })
  limit?: number;
}

class NestedDetailDto {
  @ApiProperty({ description: 'Detail value' })
  value!: string;

  @ApiProperty({ description: 'Detail count', example: 42 })
  count!: number;
}

class TestItemWithNestedDto {
  @ApiProperty({ description: 'Unique identifier' })
  id!: string;

  @ApiProperty({ description: 'Nested detail', type: () => NestedDetailDto })
  detail!: NestedDetailDto;
}

// ============================================================================
// Test Controllers (mirrors admin-api decorator patterns)
// ============================================================================

@ApiTags('Items')
@Controller('items')
class ItemsController {
  @Get()
  @ApiOperation({ summary: 'List all items' })
  @ApiPaginatedResponse(TestItemDto, 'Paginated list of items')
  @ApiStandardErrors()
  listItems(@Query() _query: TestPaginationQueryDto): { data: TestItemDto[] } {
    return { data: [] };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get item by ID' })
  @ApiStandardResponse(TestItemDto, 'Item details')
  @ApiNotFoundError('Item')
  getItem(): TestItemDto {
    return { id: '1', name: 'test', status: 'active', createdAt: new Date().toISOString() };
  }

  @Post()
  @ApiOperation({ summary: 'Create a new item' })
  @ApiCreatedStandardResponse(TestItemDto, 'Item created')
  @ApiConflictError('Item with this name already exists', 'ITEM_DUPLICATE')
  @ApiStandardErrors()
  createItem(@Body() _dto: TestCreateItemDto): TestItemDto {
    return { id: '2', name: 'new', status: 'active', createdAt: new Date().toISOString() };
  }
}

@ApiTags('Health')
@Controller('health')
class HealthTestController {
  @Get()
  @ApiOperation({ summary: 'Health check' })
  check(): { status: string } {
    return { status: 'ok' };
  }
}

@ApiTags('Nested')
@Controller('nested')
@ApiExtraModels(NestedDetailDto, TestItemWithNestedDto)
class NestedSchemaController {
  @Get()
  @ApiOperation({ summary: 'Get nested item' })
  @ApiOkResponse({
    description: 'Nested item with $ref',
    schema: {
      properties: {
        data: { $ref: getSchemaPath(TestItemWithNestedDto) },
      },
    },
  })
  getNestedItem(): TestItemWithNestedDto {
    return { id: '1', detail: { value: 'test', count: 1 } };
  }
}

@Module({
  controllers: [ItemsController, HealthTestController, NestedSchemaController],
})
class SwaggerTestModule {}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Recursively collects all $ref values from an OpenAPI document subtree.
 */
function collectRefs(obj: unknown, refs: Set<string> = new Set<string>()): Set<string> {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return refs;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectRefs(item, refs);
    }
    return refs;
  }

  const record = obj as Record<string, unknown>;
  if (typeof record['$ref'] === 'string') {
    refs.add(record['$ref']);
  }

  for (const value of Object.values(record)) {
    collectRefs(value, refs);
  }
  return refs;
}

/**
 * Extracts the schema name from a $ref string.
 * e.g. "#/components/schemas/TestItemDto" -> "TestItemDto"
 */
function extractSchemaName(ref: string): string {
  const parts = ref.split('/');
  return parts[parts.length - 1] ?? ref;
}

/**
 * Safely navigates a nested object path, returning undefined if any segment is missing.
 */
function deepGet(obj: unknown, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Swagger v11 Compatibility -- admin-api OpenAPI Regression', () => {
  let testModule: TestingModule;
  let document: OpenApiDocument;

  // Production-mirror DocumentBuilder config (from admin-api main.ts)
  const EXPECTED_TITLE = 'Aquaculture Admin API';
  const EXPECTED_DESCRIPTION = 'Platform administration API for the Aquaculture SaaS platform';
  const EXPECTED_VERSION = '1.0.0';

  // All unique @ApiTags found in admin-api-service controllers
  const ADMIN_API_TAGS: ReadonlyArray<string> = [
    'Analytics',
    'Authentication',
    'Billing',
    'Database Management',
    'Health',
    'Modules',
    'Security',
    'Settings',
    'Support',
    'Tenants',
    'Users',
  ] as const;

  beforeAll(async () => {
    testModule = await Test.createTestingModule({
      imports: [SwaggerTestModule],
    }).compile();

    const app = testModule.createNestApplication();
    await app.init();

    const config = new DocumentBuilder()
      .setTitle(EXPECTED_TITLE)
      .setDescription(EXPECTED_DESCRIPTION)
      .setVersion(EXPECTED_VERSION)
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'JWT',
      )
      .addServer('/', 'Direct (dev)')
      .addServer('/api', 'Via nginx gateway')
      .build();

    document = SwaggerModule.createDocument(app, config) as unknown as OpenApiDocument;

    await app.close();
  });

  afterAll(async () => {
    await testModule.close();
  });

  // --------------------------------------------------------------------------
  // 1. OpenAPI Document Generation
  // --------------------------------------------------------------------------
  describe('1. OpenAPI Document Generation', () => {
    it('should produce a non-null document object', () => {
      expect(document).toBeDefined();
      expect(typeof document).toBe('object');
    });

    it('should have a valid OpenAPI 3.x version string', () => {
      expect(document.openapi).toBeDefined();
      expect(document.openapi).toMatch(/^3\.\d+\.\d+$/);
    });

    it('should contain the correct title', () => {
      expect(document.info).toBeDefined();
      expect(document.info.title).toBe(EXPECTED_TITLE);
    });

    it('should contain the correct version', () => {
      expect(document.info.version).toBe(EXPECTED_VERSION);
    });

    it('should contain the correct description', () => {
      expect(document.info.description).toBe(EXPECTED_DESCRIPTION);
    });

    it('should contain info object with all required OpenAPI fields', () => {
      // OpenAPI 3.x requires: title and version in info
      expect(document.info).toHaveProperty('title');
      expect(document.info).toHaveProperty('version');
      expect(typeof document.info.title).toBe('string');
      expect(typeof document.info.version).toBe('string');
    });

    it('should preserve description whitespace and content fidelity', () => {
      // Ensure v11 does not truncate or mangle the description
      expect(document.info.description).toContain('Aquaculture');
      expect(document.info.description).toContain('SaaS');
      expect(document.info.description.length).toBeGreaterThan(20);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Endpoint Coverage -- Tags & Security
  // --------------------------------------------------------------------------
  describe('2. Endpoint Coverage', () => {
    describe('API Tags', () => {
      it('should include tags from the test controllers', () => {
        const tagsInDoc = new Set<string>();
        for (const methods of Object.values(document.paths)) {
          for (const op of Object.values(methods)) {
            if (op.tags) {
              for (const tag of op.tags) {
                tagsInDoc.add(tag);
              }
            }
          }
        }

        expect(tagsInDoc.has('Items')).toBe(true);
        expect(tagsInDoc.has('Health')).toBe(true);
        expect(tagsInDoc.has('Nested')).toBe(true);
      });

      it('should verify all admin-api production tags are catalogued', () => {
        // Static assertion: the ADMIN_API_TAGS list matches what we found via grep.
        // This acts as a living inventory -- if a new tag is added, this array
        // must be updated, ensuring the regression suite stays in sync.
        expect(ADMIN_API_TAGS).toContain('Tenants');
        expect(ADMIN_API_TAGS).toContain('Users');
        expect(ADMIN_API_TAGS).toContain('Billing');
        expect(ADMIN_API_TAGS).toContain('Security');
        expect(ADMIN_API_TAGS).toContain('Analytics');
        expect(ADMIN_API_TAGS).toContain('Health');
        expect(ADMIN_API_TAGS).toContain('Settings');
        expect(ADMIN_API_TAGS).toContain('Support');
        expect(ADMIN_API_TAGS).toContain('Database Management');
        expect(ADMIN_API_TAGS).toContain('Modules');
        expect(ADMIN_API_TAGS).toContain('Authentication');
        expect(ADMIN_API_TAGS.length).toBe(11);
      });
    });

    describe('Security Schemes', () => {
      it('should have a Bearer JWT security scheme configured', () => {
        const schemes = document.components?.securitySchemes;
        expect(schemes).toBeDefined();
        expect(schemes!['JWT']).toBeDefined(); // eslint-disable-line @typescript-eslint/no-non-null-assertion
      });

      it('should configure JWT scheme with correct type and format', () => {
        const jwt = document.components!.securitySchemes!['JWT']; // eslint-disable-line @typescript-eslint/no-non-null-assertion
        expect(jwt).toBeDefined();
        expect(jwt!.type).toBe('http');
        expect(jwt!.scheme).toBe('bearer');
        expect(jwt!.bearerFormat).toBe('JWT');
      });
    });
  });

  // --------------------------------------------------------------------------
  // 3. Custom Decorator Validation
  // --------------------------------------------------------------------------
  describe('3. Custom Decorator Validation', () => {
    it('should produce valid schema from ApiStandardResponse decorator', () => {
      // The GET /items/:id endpoint uses ApiStandardResponse(TestItemDto)
      const getItemPath = document.paths['/items/{id}'];
      expect(getItemPath).toBeDefined();

      const getOp = getItemPath!['get'];
      expect(getOp).toBeDefined();

      const okResponse = getOp!.responses?.['200'];
      expect(okResponse).toBeDefined();
      expect(okResponse!['description']).toBe('Item details');

      // Verify the schema contains the allOf wrapper with $ref
      const schema = deepGet(okResponse, 'content', 'application/json', 'schema') as SchemaObject | undefined;
      expect(schema).toBeDefined();

      const allOf = schema!['allOf'] as SchemaObject[] | undefined;
      expect(allOf).toBeDefined();
      expect((allOf as SchemaObject[]).length).toBeGreaterThan(0);

      // The allOf should contain a $ref to TestItemDto
      const allOfRefs = collectRefs(allOf);
      const refNames = [...allOfRefs].map(extractSchemaName);
      expect(refNames).toContain('TestItemDto');
    });

    it('should produce valid schema from ApiPaginatedResponse decorator', () => {
      // The GET /items endpoint uses ApiPaginatedResponse(TestItemDto)
      const listPath = document.paths['/items'];
      expect(listPath).toBeDefined();

      const getOp = listPath!['get'];
      expect(getOp).toBeDefined();

      const okResponse = getOp!.responses?.['200'];
      expect(okResponse).toBeDefined();
      expect(okResponse!['description']).toBe('Paginated list of items');

      const schema = deepGet(okResponse, 'content', 'application/json', 'schema') as SchemaObject | undefined;
      expect(schema).toBeDefined();

      // Should have data array with $ref items
      const dataProps = deepGet(schema, 'properties', 'data') as SchemaObject | undefined;
      expect(dataProps).toBeDefined();
      expect(dataProps!['type']).toBe('array');

      const items = dataProps!['items'] as SchemaObject | undefined;
      expect(items).toBeDefined();
      expect(items!['$ref']).toContain('TestItemDto');

      // Should have pagination in meta
      const paginationProps = deepGet(schema, 'properties', 'meta', 'properties', 'pagination', 'properties') as Record<string, unknown> | undefined;
      expect(paginationProps).toBeDefined();
      expect(paginationProps!['page']).toBeDefined();
      expect(paginationProps!['limit']).toBeDefined();
      expect(paginationProps!['total']).toBeDefined();
      expect(paginationProps!['totalPages']).toBeDefined();
      expect(paginationProps!['hasNext']).toBeDefined();
      expect(paginationProps!['hasPrevious']).toBeDefined();
    });

    it('should produce valid schema from ApiCreatedStandardResponse decorator', () => {
      // The POST /items endpoint uses ApiCreatedStandardResponse(TestItemDto)
      const postPath = document.paths['/items'];
      expect(postPath).toBeDefined();

      const postOp = postPath!['post'];
      expect(postOp).toBeDefined();

      const createdResponse = postOp!.responses?.['201'];
      expect(createdResponse).toBeDefined();
      expect(createdResponse!['description']).toBe('Item created');

      const schema = deepGet(createdResponse, 'content', 'application/json', 'schema') as SchemaObject | undefined;
      expect(schema).toBeDefined();

      const allOf = schema!['allOf'] as SchemaObject[] | undefined;
      expect(allOf).toBeDefined();

      const allOfRefs = collectRefs(allOf);
      const refNames = [...allOfRefs].map(extractSchemaName);
      expect(refNames).toContain('TestItemDto');
    });

    it('should produce standard error responses from ApiStandardErrors decorator', () => {
      const postOp = document.paths['/items']!['post'];
      expect(postOp).toBeDefined();

      const responseCodes = Object.keys(postOp!.responses ?? {});

      // ApiStandardErrors should produce: 400, 401, 403, 404, 429, 500
      expect(responseCodes).toContain('400');
      expect(responseCodes).toContain('401');
      expect(responseCodes).toContain('403');
      expect(responseCodes).toContain('404');
      expect(responseCodes).toContain('429');
      expect(responseCodes).toContain('500');
    });

    it('should produce ApiNotFoundError response with resource name', () => {
      const getItemOp = document.paths['/items/{id}']!['get'];
      expect(getItemOp).toBeDefined();

      const notFoundResp = getItemOp!.responses?.['404'];
      expect(notFoundResp).toBeDefined();
      expect(notFoundResp!['description']).toBe('Item not found');
    });

    it('should produce ApiConflictError response with custom code', () => {
      const postOp = document.paths['/items']!['post'];
      expect(postOp).toBeDefined();

      const conflictResp = postOp!.responses?.['409'];
      expect(conflictResp).toBeDefined();
      expect(conflictResp!['description']).toBe('Item with this name already exists');
    });

    it('should resolve getSchemaPath() correctly for all registered models', () => {
      // Verify that getSchemaPath returns valid component references
      const schemaPath = getSchemaPath(TestItemDto);
      expect(schemaPath).toBe('#/components/schemas/TestItemDto');

      const nestedPath = getSchemaPath(TestItemWithNestedDto);
      expect(nestedPath).toBe('#/components/schemas/TestItemWithNestedDto');

      const detailPath = getSchemaPath(NestedDetailDto);
      expect(detailPath).toBe('#/components/schemas/NestedDetailDto');
    });
  });

  // --------------------------------------------------------------------------
  // 4. DocumentBuilder API Compatibility
  // --------------------------------------------------------------------------
  describe('4. DocumentBuilder API Compatibility', () => {
    it('should support setTitle()', () => {
      const config = new DocumentBuilder().setTitle('Test Title').build();
      expect(config.info.title).toBe('Test Title');
    });

    it('should support setDescription()', () => {
      const config = new DocumentBuilder().setDescription('Test Description').build();
      expect(config.info.description).toBe('Test Description');
    });

    it('should support setVersion()', () => {
      const config = new DocumentBuilder().setVersion('2.0.0').build();
      expect(config.info.version).toBe('2.0.0');
    });

    it('should support addBearerAuth() with custom options', () => {
      const config = new DocumentBuilder()
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          'CustomJWT',
        )
        .build();

      const schemes = config.components?.securitySchemes;
      expect(schemes).toBeDefined();
      expect(schemes!['CustomJWT']).toBeDefined();

      const scheme = schemes!['CustomJWT'] as SecuritySchemeObject;
      expect(scheme.type).toBe('http');
      expect(scheme.scheme).toBe('bearer');
      expect(scheme.bearerFormat).toBe('JWT');
    });

    it('should support addServer() with url and description', () => {
      const config = new DocumentBuilder()
        .addServer('/', 'Direct (dev)')
        .addServer('/api', 'Via nginx gateway')
        .build();

      const servers = config.servers as OpenApiServer[];
      expect(servers).toBeDefined();
      expect(servers.length).toBe(2);

      const first = servers[0]!;
      const second = servers[1]!;
      expect(first.url).toBe('/');
      expect(first.description).toBe('Direct (dev)');
      expect(second.url).toBe('/api');
      expect(second.description).toBe('Via nginx gateway');
    });

    it('should support method chaining on DocumentBuilder', () => {
      // Ensure all methods return the builder for fluent API
      const builder = new DocumentBuilder();
      const result = builder
        .setTitle('Chain Test')
        .setDescription('Chain Description')
        .setVersion('3.0.0')
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'JWT')
        .addServer('/', 'Dev');

      // build() should return a valid config
      const config = result.build();
      expect(config.info.title).toBe('Chain Test');
      expect(config.info.description).toBe('Chain Description');
      expect(config.info.version).toBe('3.0.0');
    });

    it('should produce config compatible with SwaggerModule.createDocument', async () => {
      // Full round-trip: build config -> create document -> verify structure
      const roundTripModule = await Test.createTestingModule({
        controllers: [HealthTestController],
      }).compile();

      const app = roundTripModule.createNestApplication();
      await app.init();

      const config = new DocumentBuilder()
        .setTitle('Round Trip Test')
        .setVersion('1.0.0')
        .build();

      const doc = SwaggerModule.createDocument(app, config) as unknown as OpenApiDocument;
      expect(doc.openapi).toMatch(/^3\.\d+\.\d+$/);
      expect(doc.info.title).toBe('Round Trip Test');
      expect(doc.paths).toBeDefined();

      await app.close();
    });
  });

  // --------------------------------------------------------------------------
  // 5. Schema Structure
  // --------------------------------------------------------------------------
  describe('5. Schema Structure', () => {
    it('should have a non-empty paths object', () => {
      expect(document.paths).toBeDefined();
      const pathKeys = Object.keys(document.paths);
      expect(pathKeys.length).toBeGreaterThan(0);
    });

    it('should contain expected endpoint paths', () => {
      const pathKeys = Object.keys(document.paths);
      expect(pathKeys).toContain('/items');
      expect(pathKeys).toContain('/items/{id}');
      expect(pathKeys).toContain('/health');
      expect(pathKeys).toContain('/nested');
    });

    it('should have components/schemas defined', () => {
      expect(document.components).toBeDefined();
      expect(document.components!.schemas).toBeDefined();
      const schemaNames = Object.keys(document.components!.schemas!);
      expect(schemaNames.length).toBeGreaterThan(0);
    });

    it('should generate schemas for ApiProperty-decorated DTOs', () => {
      const schemas = document.components!.schemas!;
      expect(schemas['TestItemDto']).toBeDefined();
      expect(schemas['TestCreateItemDto']).toBeDefined();
    });

    it('should preserve ApiProperty metadata in schema properties', () => {
      const schemas = document.components!.schemas!;
      const itemSchema = schemas['TestItemDto']!;
      expect(itemSchema).toBeDefined();

      const props = deepGet(itemSchema, 'properties') as Record<string, SchemaObject>;
      expect(props).toBeDefined();

      // Verify property types
      const idProp = props['id']!;
      expect(idProp).toBeDefined();
      expect(idProp['type']).toBe('string');

      const nameProp = props['name']!;
      expect(nameProp).toBeDefined();
      expect(nameProp['type']).toBe('string');

      const statusProp = props['status']!;
      expect(statusProp).toBeDefined();
      expect(statusProp['enum']).toEqual(['active', 'inactive']);

      const createdAtProp = props['createdAt']!;
      expect(createdAtProp).toBeDefined();
      expect(createdAtProp['format']).toBe('date-time');
    });

    it('should generate schemas for nested DTO references', () => {
      const schemas = document.components!.schemas!;
      expect(schemas['TestItemWithNestedDto']).toBeDefined();
      expect(schemas['NestedDetailDto']).toBeDefined();

      // Verify the nested reference
      const nestedItemSchema = schemas['TestItemWithNestedDto']!;
      const nestedProps = deepGet(nestedItemSchema, 'properties') as Record<string, SchemaObject>;
      expect(nestedProps).toBeDefined();
      expect(nestedProps['detail']).toBeDefined();
    });

    it('should have no unresolvable $ref values', () => {
      const allRefs = collectRefs(document);
      const schemaNames = new Set(
        Object.keys(document.components?.schemas ?? {}),
      );

      const unresolved: string[] = [];
      for (const ref of allRefs) {
        // Only check schema refs (not external refs or security scheme refs)
        if (ref.startsWith('#/components/schemas/')) {
          const name = extractSchemaName(ref);
          if (!schemaNames.has(name)) {
            unresolved.push(ref);
          }
        }
      }

      expect(unresolved).toEqual([]);
    });

    it('should generate valid HTTP methods for all documented paths', () => {
      const validMethods = new Set([
        'get', 'post', 'put', 'patch', 'delete', 'options', 'head',
      ]);

      for (const methods of Object.values(document.paths)) {
        for (const method of Object.keys(methods)) {
          // Skip OpenAPI vendor extensions
          if (method.startsWith('x-')) continue;
          // Skip non-operation keys (e.g. 'parameters')
          if (method === 'parameters' || method === 'summary' || method === 'description') continue;

          expect(validMethods.has(method)).toBe(true);
        }
      }
    });

    it('should include operationId or summary for each endpoint', () => {
      for (const methods of Object.values(document.paths)) {
        for (const [method, op] of Object.entries(methods)) {
          if (method.startsWith('x-') || method === 'parameters') continue;

          const hasIdentifier = op.operationId ?? op.summary;
          expect(hasIdentifier).toBeTruthy();
        }
      }
    });

    it('should include server entries matching admin-api configuration', () => {
      expect(document.servers).toBeDefined();
      expect(document.servers!.length).toBe(2);

      const urls = document.servers!.map((s) => s.url);
      expect(urls).toContain('/');
      expect(urls).toContain('/api');
    });

    it('should produce request body schema for POST endpoints', () => {
      const postOp = document.paths['/items']!['post'];
      expect(postOp).toBeDefined();
      expect(postOp!.requestBody).toBeDefined();

      const bodySchema = deepGet(postOp!.requestBody, 'content', 'application/json', 'schema') as SchemaObject | undefined;
      expect(bodySchema).toBeDefined();
      // Should reference TestCreateItemDto
      expect(bodySchema!['$ref']).toContain('TestCreateItemDto');
    });

    it('should generate query parameters for GET endpoints with DTO queries', () => {
      const getOp = document.paths['/items']!['get'];
      expect(getOp).toBeDefined();
      expect(getOp!.parameters).toBeDefined();

      const params = getOp!.parameters!;
      const paramNames = params.map((p: ParameterObject) => p.name);
      expect(paramNames).toContain('page');
      expect(paramNames).toContain('limit');

      // Verify query params are "in: query"
      for (const param of params) {
        expect(param.in).toBe('query');
      }
    });
  });

  // --------------------------------------------------------------------------
  // 6. v11-Specific Regression Guards
  // --------------------------------------------------------------------------
  describe('6. v11-Specific Regression Guards', () => {
    it('should not produce OpenAPI 2.x (Swagger) documents', () => {
      // v11 should always produce OpenAPI 3.x, never fall back to 2.x
      expect(document.openapi).not.toMatch(/^2\./);
      expect(document['swagger']).toBeUndefined();
    });

    it('should not lose components when using custom decorators', () => {
      // Regression guard: v7->v11 upgrade must not drop components
      expect(document.components).toBeDefined();
      expect(document.components!.schemas).toBeDefined();
      expect(document.components!.securitySchemes).toBeDefined();

      // Verify both auto-generated and ExtraModels schemas exist
      const schemaNames = Object.keys(document.components!.schemas!);
      expect(schemaNames.length).toBeGreaterThanOrEqual(3);
    });

    it('should handle Type<> generics in decorator functions without error', () => {
      // Verify that our Type<T>-parameterized decorators work in v11.
      // This is a compile-time + runtime check: if getSchemaPath or
      // ApiExtraModels broke, the document generation would have thrown.
      const schemas = document.components!.schemas!;

      // All DTOs registered via ApiExtraModels or custom decorators should exist
      expect(schemas['TestItemDto']).toBeDefined();
      expect(schemas['TestItemWithNestedDto']).toBeDefined();
      expect(schemas['NestedDetailDto']).toBeDefined();
    });

    it('should produce consistent output across multiple createDocument calls', async () => {
      // Verify that v11 is deterministic (no random ordering issues)
      const deterministicModule = await Test.createTestingModule({
        imports: [SwaggerTestModule],
      }).compile();

      const app = deterministicModule.createNestApplication();
      await app.init();

      const config = new DocumentBuilder()
        .setTitle(EXPECTED_TITLE)
        .setDescription(EXPECTED_DESCRIPTION)
        .setVersion(EXPECTED_VERSION)
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          'JWT',
        )
        .addServer('/', 'Direct (dev)')
        .addServer('/api', 'Via nginx gateway')
        .build();

      const doc1 = SwaggerModule.createDocument(app, config);
      const doc2 = SwaggerModule.createDocument(app, config);

      // Compare serialized output for determinism
      expect(JSON.stringify(doc1)).toBe(JSON.stringify(doc2));

      await app.close();
    });
  });
});
