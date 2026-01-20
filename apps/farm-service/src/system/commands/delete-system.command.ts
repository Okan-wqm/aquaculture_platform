/**
 * Delete System Command
 */
export class DeleteSystemCommand {
  constructor(
    public readonly systemId: string,
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly cascade: boolean = false,
  ) {}
}
