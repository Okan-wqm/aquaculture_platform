import { SetMetadata } from '@nestjs/common';
import { ICommand } from '../command/command.interface';

/**
 * Metadata key for command handler registration
 */
export const COMMAND_HANDLER_METADATA = 'COMMAND_HANDLER_METADATA';

/**
 * Constructor type for commands
 * Using 'any[]' to allow commands with typed constructor parameters
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CommandConstructor = new (...args: any[]) => ICommand;

/**
 * Decorator options for command handler
 */
export interface CommandHandlerOptions {
  /**
   * The command class this handler processes
   */
  command: CommandConstructor;

  /**
   * Optional description for documentation
   */
  description?: string;
}

/**
 * Decorator to mark a class as a command handler
 * @param command The command class this handler processes
 */
export function CommandHandler(command: CommandConstructor): ClassDecorator {
  return (target: object) => {
    SetMetadata(COMMAND_HANDLER_METADATA, {
      command,
      commandName: command.name,
    })(target as Function);
  };
}

/**
 * Get command handler metadata from a class
 */
export function getCommandHandlerMetadata(
  target: object,
): { command: CommandConstructor; commandName: string } | undefined {
  return Reflect.getMetadata(COMMAND_HANDLER_METADATA, target);
}
