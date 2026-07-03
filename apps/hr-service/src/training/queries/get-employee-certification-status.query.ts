export class GetEmployeeCertificationStatusQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId: string,
  ) {}
}
