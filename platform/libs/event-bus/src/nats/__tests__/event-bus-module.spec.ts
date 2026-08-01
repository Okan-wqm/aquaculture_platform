import { DynamicModule } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { NatsEventBus } from '../nats-event-bus';
import { EventBusModule } from '../nats.module';

async function expectEventBusAliasToShareInstance(dynamicModule: DynamicModule): Promise<void> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [dynamicModule],
  }).compile();

  try {
    const classTokenInstance = moduleRef.get<NatsEventBus>(NatsEventBus);
    const interfaceTokenInstance = moduleRef.get<NatsEventBus>('EVENT_BUS');

    expect(interfaceTokenInstance).toBe(classTokenInstance);
  } finally {
    await moduleRef.close();
  }
}

describe('EventBusModule provider identity', () => {
  it('shares one NatsEventBus instance in forRoot', async () => {
    await expectEventBusAliasToShareInstance(EventBusModule.forRoot());
  });

  it('shares one NatsEventBus instance in forRootAsync', async () => {
    await expectEventBusAliasToShareInstance(
      EventBusModule.forRootAsync({
        useFactory: () => ({}),
      }),
    );
  });
});
