import { ArchiveFinanceCategoryHandler } from './archive-finance-category.handler';
import { CreateFinanceCategoryHandler } from './create-finance-category.handler';
import { CreateFinanceEntryHandler } from './create-finance-entry.handler';
import { DeleteFinanceEntryHandler } from './delete-finance-entry.handler';
import { RestoreFinanceCategoryHandler } from './restore-finance-category.handler';
import { UpdateFinanceCategoryHandler } from './update-finance-category.handler';
import { UpdateFinanceEntryHandler } from './update-finance-entry.handler';
import { UpdateFinanceSettingsHandler } from './update-finance-settings.handler';

export const FinanceCommandHandlers = [
  CreateFinanceEntryHandler,
  UpdateFinanceEntryHandler,
  DeleteFinanceEntryHandler,
  CreateFinanceCategoryHandler,
  UpdateFinanceCategoryHandler,
  ArchiveFinanceCategoryHandler,
  RestoreFinanceCategoryHandler,
  UpdateFinanceSettingsHandler,
];

export {
  ArchiveFinanceCategoryHandler,
  CreateFinanceCategoryHandler,
  CreateFinanceEntryHandler,
  DeleteFinanceEntryHandler,
  RestoreFinanceCategoryHandler,
  UpdateFinanceCategoryHandler,
  UpdateFinanceEntryHandler,
  UpdateFinanceSettingsHandler,
};
