/**
 * HR finance command classes (one file — small command classes grouped
 * per domain).
 */
import type {
  CreateHrFinanceCategoryInput,
  CreateHrFinanceEntryInput,
  UpdateHrFinanceCategoryInput,
  UpdateHrFinanceEntryInput,
  UpdatePayrollCostSettingsInput,
} from '../dto/hr-finance-inputs.dto';

export class CreateHrFinanceEntryCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: CreateHrFinanceEntryInput,
    public readonly userId: string,
  ) {}
}

export class UpdateHrFinanceEntryCommand {
  constructor(
    public readonly tenantId: string,
    public readonly entryId: string,
    public readonly input: UpdateHrFinanceEntryInput,
    public readonly userId: string,
  ) {}
}

export class DeleteHrFinanceEntryCommand {
  constructor(
    public readonly tenantId: string,
    public readonly entryId: string,
    public readonly userId: string,
  ) {}
}

export class CreateHrFinanceCategoryCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: CreateHrFinanceCategoryInput,
    public readonly userId: string,
  ) {}
}

export class UpdateHrFinanceCategoryCommand {
  constructor(
    public readonly tenantId: string,
    public readonly categoryId: string,
    public readonly input: UpdateHrFinanceCategoryInput,
    public readonly userId: string,
  ) {}
}

export class ArchiveHrFinanceCategoryCommand {
  constructor(
    public readonly tenantId: string,
    public readonly categoryId: string,
    public readonly userId: string,
  ) {}
}

export class RestoreHrFinanceCategoryCommand {
  constructor(
    public readonly tenantId: string,
    public readonly categoryId: string,
    public readonly userId: string,
  ) {}
}

export class UpdatePayrollCostSettingsCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: UpdatePayrollCostSettingsInput,
    public readonly userId: string,
  ) {}
}
