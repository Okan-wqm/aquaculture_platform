import type { UpdateFinanceEntryInput } from '../dto/finance-inputs.dto';

export class UpdateFinanceEntryCommand {
  constructor(
    public readonly tenantId: string,
    public readonly entryId: string,
    public readonly input: UpdateFinanceEntryInput,
    public readonly userId: string,
  ) {}
}
