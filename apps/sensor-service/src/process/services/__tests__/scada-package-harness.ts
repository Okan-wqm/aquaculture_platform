// The app tsconfig compiles `src/**/*.ts` and excludes only `*.spec.ts` /
// `*.test.ts`, so this helper is in the production build's file set under
// `types: ["node"]` and would not otherwise see the jest globals. Same
// directive, same reason, as `make-mock-event-bus.ts` in farm-service.
/// <reference types="jest" />
import type { Provider } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Process } from '../../entities/process.entity';
import { ScadaPackage } from '../../entities/scada-package.entity';
import { ScadaPackageService } from '../scada-package.service';

/**
 * The one place a focused `ScadaPackageService` test module is wired.
 *
 * # Why
 *
 * Five `Test.createTestingModule` blocks across three spec files each restated
 * the same four providers — the service, an `EventEmitter2` stub, and the
 * `ScadaPackage` / `Process` repository tokens — differing only in the mocks
 * they passed. The emitter in particular was pure boilerplate: no spec asserted
 * on it, it was there because the constructor requires it. A copy that exists
 * only to satisfy a constructor is a copy that will be forgotten when the
 * constructor changes, and the test that forgets it fails at DI resolution with
 * an error about a missing provider rather than about the behaviour under test.
 *
 * There were eight such blocks across six spec files, not the five across three
 * that a reading of the obvious ones found — the last three were surfaced by
 * the invariant written for this fix, which is the argument for having it.
 *
 * Enforced by `tests/invariants/scada-package-harness-single-source.spec.ts`
 * (SENSOR-MEDIUM-112), so a ninth copy fails CI instead of being reviewed for.
 */
export interface ScadaPackageHarness {
  module: TestingModule;
  service: ScadaPackageService;
  /**
   * The emitter stub the service was constructed with. Returned rather than
   * hidden so a test that DOES care about a lifecycle event can assert on it
   * without re-declaring the module.
   */
  emit: jest.Mock;
}

/**
 * Builds a `ScadaPackageService` over its two required repositories.
 *
 * `processRepository` defaults to a `findOne`-only stub because that is what
 * every current caller passes; pass one explicitly when a test needs it to
 * answer. `providers` are appended, so a caller adds only the optional
 * collaborators its case exercises — which is what the "degrades when the
 * optional deps are absent" case depends on being able to omit.
 */
export async function createScadaPackageHarness(options: {
  scadaPackageRepository: unknown;
  processRepository?: unknown;
  providers?: Provider[];
}): Promise<ScadaPackageHarness> {
  const emit = jest.fn();

  const module = await Test.createTestingModule({
    providers: [
      ScadaPackageService,
      { provide: EventEmitter2, useValue: { emit } },
      { provide: getRepositoryToken(ScadaPackage), useValue: options.scadaPackageRepository },
      {
        provide: getRepositoryToken(Process),
        useValue: options.processRepository ?? { findOne: jest.fn() },
      },
      ...(options.providers ?? []),
    ],
  }).compile();

  return { module, service: module.get(ScadaPackageService), emit };
}
