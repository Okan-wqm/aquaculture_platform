export class DeleteWorkerCommand {
  constructor(
    public readonly workerId: string,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
