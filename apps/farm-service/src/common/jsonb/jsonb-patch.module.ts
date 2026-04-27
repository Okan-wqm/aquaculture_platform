/**
 * JsonbPatchModule
 *
 * Global provider for `JsonbPatchService` so any domain module can
 * inject it without its own plumbing. The service depends on the
 * default DataSource which is already available via the root
 * TypeOrmModule.forRoot() — no extra imports needed.
 *
 * Phase 5.7 of the "Farm modülü kalan kör noktalar" plan.
 */
import { Global, Module } from '@nestjs/common';

import { JsonbPatchService } from './jsonb-patch.service';

@Global()
@Module({
  providers: [JsonbPatchService],
  exports: [JsonbPatchService],
})
export class JsonbPatchModule {}
