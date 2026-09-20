import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { resolveErrorCapturePublisher } from '../create-service-app';
import { resolveOptionalProvider } from '../optional-provider';

/**
 * INFRA-HIGH-184: these tests boot through `NestFactory.create` on purpose.
 * `Test.createTestingModule` returns a bare application context without the
 * ExceptionsZone proxy, so it cannot reproduce the defect — a missing token
 * looked up through `app.get` there is a catchable exception, while through
 * the factory-built application it is `process.exit(1)`.
 */

@Module({})
class NoEventBusModule {}

const eventBus = { publish: jest.fn() };

@Module({ providers: [{ provide: 'EVENT_BUS', useValue: eventBus }] })
class WithEventBusModule {}

class ProcessExitAttempted extends Error {}

describe('resolveOptionalProvider (INFRA-HIGH-184)', () => {
  let exitSpy: jest.SpyInstance;
  const apps: INestApplication[] = [];

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code?: unknown): never => {
      throw new ProcessExitAttempted(`process.exit(${String(code)})`);
    });
  });

  afterEach(async () => {
    exitSpy.mockRestore();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function boot(module: typeof NoEventBusModule): Promise<INestApplication> {
    const app = await NestFactory.create(module, { logger: false });
    apps.push(app);
    return app;
  }

  it('returns undefined for a token no module registered, without exiting the process', async () => {
    const app = await boot(NoEventBusModule);

    expect(resolveOptionalProvider(app, 'EVENT_BUS')).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('returns the registered provider', async () => {
    const app = await boot(WithEventBusModule);

    expect(resolveOptionalProvider(app, 'EVENT_BUS')).toBe(eventBus);
  });

  it('documents the defect it replaces: app.get on a factory-built app exits the process', async () => {
    const app = await boot(NoEventBusModule);

    expect((): unknown => app.get('EVENT_BUS', { strict: false })).toThrow(ProcessExitAttempted);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('resolveErrorCapturePublisher', () => {
  it('is inert for a service without an event bus and says so once', async () => {
    const app = await NestFactory.create(NoEventBusModule, { logger: false });
    const logger = { log: jest.fn() };
    try {
      expect(resolveErrorCapturePublisher(app, logger)).toBeUndefined();
      expect(logger.log).toHaveBeenCalledWith(
        'No EVENT_BUS registered; error capture is inert for this service',
      );
    } finally {
      await app.close();
    }
  });

  it('hands the registered event bus to the interceptor', async () => {
    const app = await NestFactory.create(WithEventBusModule, { logger: false });
    const logger = { log: jest.fn() };
    try {
      expect(resolveErrorCapturePublisher(app, logger)).toBe(eventBus);
      expect(logger.log).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
