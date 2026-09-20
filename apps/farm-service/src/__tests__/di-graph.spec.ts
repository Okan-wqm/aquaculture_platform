import { assertNestGraphResolves } from '@platform/testing';

import { AppModule } from '../app.module';

// The dependency graph production builds, built here without instantiating a
// provider (no database, broker or cache). A "Nest can't resolve dependencies"
// thrown here is the message the container would have logged at boot.
// See libs/testing/src/nest/preview-graph.ts (ORPHAN-HIGH-834).
describe('farm-service dependency graph', () => {
  it('resolves every provider, controller and resolver of AppModule', async () => {
    await assertNestGraphResolves(AppModule);
  }, 60_000);
});
