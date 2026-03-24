import { Global, Module } from '@nestjs/common';
import { AuthSchemaBootstrapService } from './schema-bootstrap.service';

/**
 * AuthSchemaBootstrapModule — Global module that bootstraps auth schema on startup.
 *
 * WHY: Must be imported FIRST in AppModule.imports[] to ensure schema columns exist
 * before any other module's OnModuleInit runs (especially SeedService).
 * NestJS initializes imported modules in declaration order — placing this first
 * guarantees the bootstrap DDL runs before any entity queries.
 */
@Global()
@Module({
  providers: [AuthSchemaBootstrapService],
  exports: [AuthSchemaBootstrapService],
})
export class AuthSchemaBootstrapModule {}
