import {
  CommandBus,
  CommandHandler,
  CqrsModule,
  ICommand,
  ICommandHandler,
  IQuery,
  IQueryHandler,
  QueryBus,
  QueryHandler,
} from '../../platform/libs/cqrs/src';
import type { Type } from '@nestjs/common';

class CreateThingCommand implements ICommand {
  constructor(readonly id: string) {}
}

class GetThingQuery implements IQuery {
  constructor(readonly id: string) {}
}

@CommandHandler(CreateThingCommand)
class CreateThingHandler implements ICommandHandler<CreateThingCommand> {
  readonly seen: string[] = [];

  execute(command: CreateThingCommand): Promise<void> {
    this.seen.push(command.id);
    return Promise.resolve();
  }
}

@QueryHandler(GetThingQuery)
class GetThingHandler implements IQueryHandler<GetThingQuery, string> {
  execute(query: GetThingQuery): Promise<string> {
    return Promise.resolve('got:' + query.id);
  }
}

function renameClassForMinificationSimulation(target: object, name: string): void {
  Object.defineProperty(target, 'name', { value: name, configurable: true });
}

describe('CQRS class-reference handler registration', () => {
  it('auto-registers discovered handlers through class-reference register()', () => {
    const discovery = {
      getProviders: jest.fn(() => [
        { instance: new CreateThingHandler(), metatype: CreateThingHandler },
        { instance: new GetThingHandler(), metatype: GetThingHandler },
      ]),
    };
    const commandBus = {
      register: jest.fn(),
      registerByName: jest.fn(),
    };
    const queryBus = {
      register: jest.fn(),
      registerByName: jest.fn(),
    };

    new CqrsModule(discovery as never, commandBus as never, queryBus as never).onModuleInit();

    expect(commandBus.register).toHaveBeenCalledWith(CreateThingCommand, CreateThingHandler);
    expect(queryBus.register).toHaveBeenCalledWith(GetThingQuery, GetThingHandler);
    expect(commandBus.registerByName).not.toHaveBeenCalled();
    expect(queryBus.registerByName).not.toHaveBeenCalled();
  });

  it('dispatches commands by class reference even when constructor.name changes after registration', async () => {
    const handler = new CreateThingHandler();
    const moduleRef = {
      get: jest.fn((type: Type<ICommandHandler<ICommand, unknown>>) =>
        type === CreateThingHandler ? handler : undefined,
      ),
    };
    const bus = new CommandBus(moduleRef as never);

    bus.register(CreateThingCommand, CreateThingHandler);
    renameClassForMinificationSimulation(CreateThingCommand, 'a');

    await expect(bus.execute(new CreateThingCommand('42'))).resolves.toBeUndefined();
    expect(handler.seen).toEqual(['42']);
  });

  it('dispatches queries by class reference even when constructor.name changes after registration', async () => {
    const handler = new GetThingHandler();
    const moduleRef = {
      get: jest.fn((type: Type<IQueryHandler<IQuery, unknown>>) =>
        type === GetThingHandler ? handler : undefined,
      ),
    };
    const bus = new QueryBus(moduleRef as never);

    bus.register(GetThingQuery, GetThingHandler);
    renameClassForMinificationSimulation(GetThingQuery, 'b');

    await expect(bus.execute(new GetThingQuery('42'))).resolves.toBe('got:42');
  });
});
