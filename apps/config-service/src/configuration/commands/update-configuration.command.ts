import { UpdateConfigurationInput } from '../dto/create-configuration.input';

export class UpdateConfigurationCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: UpdateConfigurationInput,
    public readonly userId: string,
  ) {}
}
