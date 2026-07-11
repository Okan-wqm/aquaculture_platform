import type { CreateFinanceCategoryInput } from '../dto/finance-inputs.dto';

export class CreateFinanceCategoryCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: CreateFinanceCategoryInput,
    public readonly userId: string,
  ) {}
}
