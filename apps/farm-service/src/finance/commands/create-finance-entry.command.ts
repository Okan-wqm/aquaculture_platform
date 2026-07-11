import type { CreateFinanceEntryInput } from '../dto/finance-inputs.dto';

export class CreateFinanceEntryCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: CreateFinanceEntryInput,
    public readonly userId: string,
  ) {}
}
