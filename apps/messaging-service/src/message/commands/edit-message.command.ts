import { ICommand } from '@nestjs/cqrs';

/**
 * Command to edit an existing message's content.
 */
export class EditMessageCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly messageId: string,
    public readonly newContent: string,
  ) {}
}
