export class DeleteConfigurationCommand {
  constructor(
    public readonly tenantId: string,
    public readonly configurationId: string,
    public readonly userId: string,
    public readonly hardDelete: boolean = false,
  ) {}
}
