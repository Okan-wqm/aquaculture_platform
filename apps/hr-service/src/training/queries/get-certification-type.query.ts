export class GetCertificationTypeQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
