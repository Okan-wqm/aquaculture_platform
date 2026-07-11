import type { UpdateFinanceCategoryInput } from '../dto/finance-inputs.dto';

export class UpdateFinanceCategoryCommand {
  constructor(
    public readonly tenantId: string,
    public readonly categoryId: string,
    public readonly input: UpdateFinanceCategoryInput,
    public readonly userId: string,
  ) {}
}
