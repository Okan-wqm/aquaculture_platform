export class DeactivatePlanCommand {
  constructor(
    public readonly planId: string,
    public readonly userId: string,
  ) {}
}
