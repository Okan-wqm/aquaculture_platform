import { Global, Module } from '@nestjs/common';

import { CompositionStateService } from './composition-state.service';

/**
 * ARCH-GW-006: CompositionStateModule.
 *
 * @Global so the single CompositionStateService instance is visible both to the
 * GraphQLModule.forRootAsync factory (which injects it and hands it to the
 * BackgroundCompositionManager — the WRITER) and to HealthService (the READER),
 * without each consumer having to re-import this module. There is exactly one
 * composition-readiness fact per gateway process, so a process-global singleton
 * is the correct shape.
 */
@Global()
@Module({
  providers: [CompositionStateService],
  exports: [CompositionStateService],
})
export class CompositionStateModule {}
