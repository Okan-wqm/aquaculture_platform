import { ICommand } from '@nestjs/cqrs';

/** Activation-only command. Legal-hold release has its own two-person workflow. */
export class ActivateLegalHoldCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly channelId: string | null,
    public readonly reason: string,
    public readonly legalMatterId: string,
    public readonly legalMatterDescription: string | null = null,
    public readonly requestedBy: string | null = null,
    public readonly expiresAt: Date | null = null,
  ) {}
}
