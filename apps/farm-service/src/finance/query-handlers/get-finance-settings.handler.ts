import { Injectable } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@platform/cqrs';

import { FinanceSettings } from '../entities/finance-settings.entity';
import { GetFinanceSettingsQuery } from '../queries/get-finance-settings.query';
import { FinanceSettingsService } from '../services/finance-settings.service';

@Injectable()
@QueryHandler(GetFinanceSettingsQuery)
export class GetFinanceSettingsHandler implements IQueryHandler<GetFinanceSettingsQuery> {
  constructor(private readonly settingsService: FinanceSettingsService) {}

  async execute(query: GetFinanceSettingsQuery): Promise<FinanceSettings> {
    return this.settingsService.getSettings(query.tenantId);
  }
}
