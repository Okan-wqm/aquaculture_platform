import { Injectable, Type, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ICommand, ICommandBus, ICommandHandler } from './command.interface';
import { COMMAND_HANDLER_METADATA } from '../decorators/command-handler.decorator';

/**
 * Command Bus Implementation
 * Routes commands to their respective handlers
 * Enterprise-grade with logging, error handling, and metrics
 */
@Injectable()
export class CommandBus implements ICommandBus {
  private readonly logger = new Logger(CommandBus.name);
  private readonly handlers = new Map<
    string,
    Type<ICommandHandler<ICommand, unknown>>
  >();

  constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * Execute a command through the bus
   * @param command The command to execute
   * @returns The result from the handler
   */
  async execute<TCommand extends ICommand, TResult = void>(
    command: TCommand,
  ): Promise<TResult> {
    const commandName = command.constructor.name;
    const startTime = Date.now();

    this.logger.debug(`Executing command: ${commandName}`);

    const handlerType = this.handlers.get(commandName);
    if (!handlerType) {
      const error = `No handler registered for command: ${commandName}`;
      this.logger.error(error);
      throw new Error(error);
    }

    try {
      const handler = this.moduleRef.get(handlerType, { strict: false });
      if (!handler) {
        throw new Error(`Handler instance not found for: ${commandName}`);
      }

      const result = await handler.execute(command);

      const duration = Date.now() - startTime;
      this.logger.debug(
        `Command ${commandName} executed successfully in ${duration}ms`,
      );

      return result as TResult;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Command ${commandName} failed after ${duration}ms`,
        error instanceof Error ? error.stack : error,
      );
      throw error;
    }
  }

  /**
   * Register a handler for a command type
   */
  register<TCommand extends ICommand>(
    commandType: new (...args: any[]) => TCommand,
    handler: Type<ICommandHandler<TCommand>>,
  ): void {
    const commandName = commandType.name;
    if (this.handlers.has(commandName)) {
      this.logger.warn(`Overwriting handler for command: ${commandName}`);
    }
    this.handlers.set(commandName, handler as Type<ICommandHandler<ICommand, unknown>>);
    this.logger.log(`Registered handler for command: ${commandName}`);
  }

  /**
   * Register a handler by command name
   */
  registerByName(
    commandName: string,
    handler: Type<ICommandHandler<ICommand, unknown>>,
  ): void {
    if (this.handlers.has(commandName)) {
      this.logger.warn(`Overwriting handler for command: ${commandName}`);
    }
    this.handlers.set(commandName, handler);
    this.logger.log(`Registered handler for command: ${commandName}`);
  }

  /**
   * Check if a handler is registered for a command
   */
  hasHandler(commandName: string): boolean {
    return this.handlers.has(commandName);
  }

  /**
   * Get all registered command types
   */
  getRegisteredCommands(): string[] {
    return Array.from(this.handlers.keys());
  }
}
