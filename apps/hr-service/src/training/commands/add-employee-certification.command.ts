export class AddEmployeeCertificationCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly employeeId: string,
    public readonly certificationTypeId: string,
    public readonly issueDate: string,
    public readonly expiryDate?: string,
    public readonly issuingAuthority?: string,
    public readonly externalCertificationId?: string,
    public readonly notes?: string,
  ) {}
}
