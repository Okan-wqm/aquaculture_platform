import { Injectable, Type, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ICommand, ICommandBus, ICommandHandler } from './command.interface';
import { COMMAND_HANDLER_METADATA } from '../decorators/command-handler.decorator';

/**
 * Command Bus Implementation
 * Routes commands to their respective handlers
 * Enterprise-grade with logging, error handling, and metrics
 */
/**
 * # Why two parallel Maps (typeHandlers + nameHandlers)
 *
 * PLAT-HIGH-002 captured the regression class: dispatching by
 * `command.constructor.name` is a footgun under any build pipeline
 * that touches class names. webpack/esbuild minification can rewrite
 * `CreateFarmCommand` into `a` at runtime, while the handler was
 * registered under the un-mangled name — the Map lookup misses
 * silently and `execute()` throws "no handler registered" with the
 * minified name in the error, making the cause invisible.
 *
 * The Tier-1 architectural cure is to key the primary lookup by the
 * COMMAND CLASS REFERENCE (Type<TCommand>), not its string name.
 * Class references are pointer-equal across minification — there is
 * exactly one class object regardless of whether its display name was
 * rewritten. `command.constructor` returns that pointer, so
 * `typeHandlers.get(command.constructor)` always resolves correctly.
 *
 * The string-keyed Map is preserved as a SECONDARY index for the
 * `registerByName(name, handler)` path used by tests + dynamic
 * registration. New code SHOULD use the class-reference path.
 */
@Injectable()
export class CommandBus implements ICommandBus {
  private readonly logger = new Logger(CommandBus.name);
  /** Primary: keyed by class reference (minification-proof). */
  private readonly typeHandlers = new Map<
    Type<ICommand>,
    Type<ICommandHandler<ICommand, unknown>>
  >();
  /** Secondary: keyed by string name (registerByName + diagnostics). */
  private readonly nameHandlers = new Map<
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
    // Resolve via the class-reference Map first — minification-proof.
    // The string name is used only for logging.
    const commandType = command.constructor as Type<ICommand>;
    const commandName = commandType.name; // for logging only
    const startTime = Date.now();

    this.logger.debug(`Executing command: ${commandName}`);

    let handlerType = this.typeHandlers.get(commandType);
    if (!handlerType) {
      // Fall back to name-keyed lookup for legacy registerByName() paths.
      // If both miss, throw with both keys in the error message so the
      // operator can see whether minification rewrote the class name.
      handlerType = this.nameHandlers.get(commandName);
    }
    if (!handlerType) {
      const error = `No handler registered for command: ${commandName} (class ref ${commandType.name})`;
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
   * Register a handler for a command type.
   *
   * Stores the binding in BOTH Maps so both dispatch paths
   * (class-reference + string-name) resolve. The class-reference
   * binding is the primary; the string binding is the secondary
   * for hasHandler(name) callers and getRegisteredCommands() output.
   */
  register<TCommand extends ICommand>(
    commandType: new (...args: any[]) => TCommand,
    handler: Type<ICommandHandler<TCommand>>,
  ): void {
    const commandName = commandType.name;
    const typed = commandType as unknown as Type<ICommand>;
    const typedHandler = handler as Type<ICommandHandler<ICommand, unknown>>;
    if (this.typeHandlers.has(typed)) {
      this.logger.warn(`Overwriting handler for command: ${commandName}`);
    }
    this.typeHandlers.set(typed, typedHandler);
    this.nameHandlers.set(commandName, typedHandler);
    this.logger.log(`Registered handler for command: ${commandName}`);
  }

  /**
   * Register a handler by command name.
   *
   * Used by dynamic / test paths where the class reference is not
   * available at registration time. Only populates the name-keyed
   * Map; consumers that dispatch via `execute(command)` MUST register
   * via the class-reference `register()` overload to be minification-
   * proof.
   */
  registerByName(
    commandName: string,
    handler: Type<ICommandHandler<ICommand, unknown>>,
  ): void {
    if (this.nameHandlers.has(commandName)) {
      this.logger.warn(`Overwriting handler for command: ${commandName}`);
    }
    this.nameHandlers.set(commandName, handler);
    this.logger.log(`Registered handler for command (by name): ${commandName}`);
  }

  /**
   * Check if a handler is registered for a command name.
   */
  hasHandler(commandName: string): boolean {
    return this.nameHandlers.has(commandName);
  }

  /**
   * Get all registered command names.
   */
  getRegisteredCommands(): string[] {
    return Array.from(this.nameHandlers.keys());
  }
}
