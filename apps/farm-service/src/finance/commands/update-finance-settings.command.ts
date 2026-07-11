import type { UpdateFinanceSettingsInput } from '../dto/finance-inputs.dto';

export class UpdateFinanceSettingsCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: UpdateFinanceSettingsInput,
    public readonly userId: string,
  ) {}
}
