import { SetMetadata } from '@nestjs/common';
import { ICommand } from '../command/command.interface';

/**
 * Metadata key for command handler registration
 */
export const COMMAND_HANDLER_METADATA = 'COMMAND_HANDLER_METADATA';

/**
 * Decorator options for command handler
 */
export interface CommandHandlerOptions {
  /**
   * The command class this handler processes
   */
  command: new (...args: any[]) => ICommand;

  /**
   * Optional description for documentation
   */
  description?: string;
}

/**
 * Decorator to mark a class as a command handler
 * @param command The command class this handler processes
 */
export function CommandHandler(
  command: new (...args: any[]) => ICommand,
): ClassDecorator {
  return (target: object) => {
    SetMetadata(COMMAND_HANDLER_METADATA, {
      command,
      commandName: command.name,
    })(target as any);
  };
}

/**
 * Get command handler metadata from a class
 */
export function getCommandHandlerMetadata(
  target: object,
): { command: new (...args: any[]) => ICommand; commandName: string } | undefined {
  return Reflect.getMetadata(COMMAND_HANDLER_METADATA, target);
}
