import type { Provider } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';

import { ScadaPackageService } from '../scada-package.service';

/**
 * Build a ScadaPackageService test module with its required lifecycle-event
 * infrastructure. Keeping the dependency here prevents focused service tests
 * from silently drifting when the production constructor changes.
 */
export async function createScadaPackageTestingModule(
  providers: Provider[],
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [EventEmitterModule.forRoot()],
    providers: [ScadaPackageService, ...providers],
  }).compile();
}
