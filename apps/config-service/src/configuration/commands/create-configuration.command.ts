import { CreateConfigurationInput } from '../dto/create-configuration.input';

export class CreateConfigurationCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: CreateConfigurationInput,
    public readonly userId: string,
  ) {}
}
