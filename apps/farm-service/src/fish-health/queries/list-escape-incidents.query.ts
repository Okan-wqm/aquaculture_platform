import { EscapeIncidentStatus } from '../entities/escape-incident.entity';

/**
 * List escape incidents, optionally narrowed to a site and lifecycle status.
 */
export class ListEscapeIncidentsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly siteId?: string,
    public readonly status?: EscapeIncidentStatus,
  ) {}
}
