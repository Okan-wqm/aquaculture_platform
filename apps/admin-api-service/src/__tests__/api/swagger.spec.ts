import {
  INestApplication,
  Controller,
  Get,
  Post,
  Body,
  HttpStatus,
  ValidationPipe,
  VersioningType,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Test, TestingModule } from '@nestjs/testing';
import { IsString, IsNotEmpty } from 'class-validator';
import request from 'supertest';

import { Public } from '@aquaculture/backend-common/decorators';

class TestDto {
  @IsString()
  @IsNotEmpty()
  name!: string;
}

@Controller('swagger-test')
class SwaggerTestController {
  @Get('items')
  @Public()
  getItems() {
    return [{ id: 1, name: 'test' }];
  }

  @Post('items')
  @Public()
  createItem(@Body() dto: TestDto) {
    return { id: 2, ...dto };
  }
}

describe('Swagger / OpenAPI Documentation', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [SwaggerTestController],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Mirror the versioning config from main.ts
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: ['1', VERSION_NEUTRAL],
    });

    // Mirror the Swagger config from main.ts
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Aquaculture Admin API')
      .setDescription('Platform administration API for the Aquaculture SaaS platform')
      .setVersion('1.0.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'JWT')
      .addServer('/', 'Direct (dev)')
      .addServer('/api', 'Via nginx gateway')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      },
    });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Swagger UI availability', () => {
    it('should serve the Swagger UI page at /docs', async () => {
      const response = await request(app.getHttpServer()).get('/docs/');

      // Swagger UI redirects or returns HTML
      expect([HttpStatus.OK, HttpStatus.MOVED_PERMANENTLY, HttpStatus.FOUND]).toContain(
        response.status,
      );
    });

    it('should serve the OpenAPI JSON spec at /docs-json', async () => {
      const response = await request(app.getHttpServer()).get('/docs-json');

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toBeDefined();
      expect(response.body.openapi).toBeDefined();
      expect(response.body.info).toBeDefined();
    });
  });

  describe('OpenAPI spec structure', () => {
    let spec: Record<string, any>;

    beforeAll(async () => {
      const response = await request(app.getHttpServer()).get('/docs-json');
      spec = response.body;
    });

    it('should have valid OpenAPI 3.x version', () => {
      expect(spec['openapi']).toMatch(/^3\.\d+\.\d+$/);
    });

    it('should contain correct API title and version', () => {
      expect(spec['info'].title).toBe('Aquaculture Admin API');
      expect(spec['info'].version).toBe('1.0.0');
    });

    it('should contain API description', () => {
      expect(spec['info'].description).toContain('Aquaculture');
    });

    it('should define Bearer JWT security scheme', () => {
      const securitySchemes = spec['components']?.securitySchemes;
      expect(securitySchemes).toBeDefined();
      expect(securitySchemes.JWT).toBeDefined();
      expect(securitySchemes.JWT.type).toBe('http');
      expect(securitySchemes.JWT.scheme).toBe('bearer');
      expect(securitySchemes.JWT.bearerFormat).toBe('JWT');
    });

    it('should define server entries', () => {
      expect(spec['servers']).toBeDefined();
      expect(spec['servers'].length).toBeGreaterThanOrEqual(1);

      const urls = spec['servers'].map((s: any) => s.url);
      expect(urls).toContain('/');
    });

    it('should have paths section with documented endpoints', () => {
      expect(spec['paths']).toBeDefined();
      const pathKeys = Object.keys(spec['paths']);
      expect(pathKeys.length).toBeGreaterThan(0);
    });

    it('documented endpoints should reference valid HTTP methods', () => {
      const validMethods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
      for (const [, methods] of Object.entries(spec['paths'])) {
        for (const method of Object.keys(methods as object)) {
          if (method.startsWith('x-')) continue; // OpenAPI extensions
          expect(validMethods).toContain(method);
        }
      }
    });
  });
});
