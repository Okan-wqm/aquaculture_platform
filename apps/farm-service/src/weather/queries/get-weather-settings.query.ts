/**
 * Get Weather Settings Query
 */
import { IQuery } from '@platform/cqrs';

export class GetWeatherSettingsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
