export class RevokeCertificationCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly certificationId: string,
    public readonly reason: string,
  ) {}
}
