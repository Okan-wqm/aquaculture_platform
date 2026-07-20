import 'reflect-metadata';
import type { INestApplication, Logger } from '@nestjs/common';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';

import { findOrphanedMicroserviceHandlers } from './create-service-app';

/**
 * Unit coverage for the cold-start liveness guard behind APA-030. A service
 * that registers @EventPattern/@MessagePattern handlers but no natsTransport
 * ships dead code; findOrphanedMicroserviceHandlers detects exactly that so
 * bootstrap can process.exit(1) instead of stalling silently in production.
 */
describe('findOrphanedMicroserviceHandlers (APA-030 cold-start guard)', () => {
  const logger: Pick<Logger, 'warn'> = { warn: jest.fn() };

  function appWith(
    controllers: Array<{ name: string; instance: object }>,
  ): Pick<INestApplication, 'get'> {
    const modulesContainer = new Map([
      ['module-a', { controllers: new Map(controllers.map((c, i) => [String(i), c])) }],
    ]);
    const get = jest.fn();
    get.mockReturnValue(modulesContainer);
    return { get };
  }

  it('flags controllers with @EventPattern/@MessagePattern methods', () => {
    class OnboardingAckHandler {
      public calls = 0;
      handleAck(): void {
        this.calls += 1;
      }
      helper(): void {
        this.calls += 1;
      }
    }
    // Simulate @EventPattern by stamping PATTERN_METADATA on the handler method.
    Reflect.defineMetadata(
      PATTERN_METADATA,
      ['events.*.TenantOnboardingAck'],
      OnboardingAckHandler.prototype.handleAck,
    );

    const orphaned = findOrphanedMicroserviceHandlers(
      appWith([{ name: 'OnboardingAckHandler', instance: new OnboardingAckHandler() }]),
      'admin-api-service',
      logger,
    );

    expect(orphaned).toEqual(['OnboardingAckHandler#handleAck']);
  });

  it('returns [] for a service whose controllers have only plain HTTP methods', () => {
    class TenantController {
      public calls = 0;
      list(): void {
        this.calls += 1;
      }
      create(): void {
        this.calls += 1;
      }
    }

    const orphaned = findOrphanedMicroserviceHandlers(
      appWith([{ name: 'TenantController', instance: new TenantController() }]),
      'admin-api-service',
      logger,
    );

    expect(orphaned).toEqual([]);
  });

  it('fails open (returns []) and warns if the module scan throws', () => {
    const get = jest.fn();
    get.mockImplementation(() => {
      throw new Error('container unavailable');
    });
    const brokenApp: Pick<INestApplication, 'get'> = { get };

    expect(findOrphanedMicroserviceHandlers(brokenApp, 'svc', logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });
});
