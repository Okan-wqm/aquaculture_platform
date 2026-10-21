/**
 * List a site's temperature scenarios with their dated points.
 */
import { IQuery } from '@platform/cqrs';

export class GetTemperatureScenariosQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly siteId: string,
  ) {}
}
