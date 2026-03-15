export class GetGoalQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
