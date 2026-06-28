export class RenewCertificationCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly certificationId: string,
    public readonly newExpiryDate: string,
    public readonly certificateNumber?: string,
    public readonly attachmentUrl?: string,
  ) {}
}
