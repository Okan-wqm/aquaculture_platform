export class GetMandatoryTrainingStatusQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId: string,
  ) {}
}
