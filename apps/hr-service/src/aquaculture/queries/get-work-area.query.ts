export class GetWorkAreaQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
