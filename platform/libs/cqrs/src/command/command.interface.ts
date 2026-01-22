/**
 * Base Command Interface
 * Commands represent intentions to change state in the system
 * Empty interface - commands are identified by their class type
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ICommand {}

/**
 * Tenant-scoped command interface
 */
export interface ITenantCommand extends ICommand {
  /**
   * Tenant context for multi-tenancy
   */
  readonly tenantId: string;
}

/**
 * Command Handler Interface
 * Implements the business logic for processing commands
 */
export interface ICommandHandler<
  TCommand extends ICommand = ICommand,
  TResult = void,
> {
  /**
   * Execute the command and return a result
   */
  execute(command: TCommand): Promise<TResult>;
}

/**
 * Type helper for class constructors
 */
export type Type<T = unknown> = new (...args: unknown[]) => T;

/**
 * Command Bus Interface
 * Routes commands to their handlers
 */
export interface ICommandBus {
  /**
   * Execute a command through the bus
   */
  execute<TCommand extends ICommand, TResult = void>(
    command: TCommand,
  ): Promise<TResult>;

  /**
   * Register a handler for a command type
   */
  register<TCommand extends ICommand>(
    commandType: new (...args: unknown[]) => TCommand,
    handler: Type<ICommandHandler<TCommand>>,
  ): void;
}

/**
 * Command metadata type
 */
export interface CommandMetadata {
  commandType: string;
  handlerType: new (...args: unknown[]) => ICommandHandler;
}

/**
 * Command Result wrapper for standardized responses
 */
export interface CommandResult<T = void> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Create a successful command result
 */
export function commandSuccess<T>(data?: T): CommandResult<T> {
  return {
    success: true,
    data,
  };
}

/**
 * Create a failed command result
 */
export function commandFailure<T>(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): CommandResult<T> {
  return {
    success: false,
    error: {
      code,
      message,
      details,
    },
  };
}
