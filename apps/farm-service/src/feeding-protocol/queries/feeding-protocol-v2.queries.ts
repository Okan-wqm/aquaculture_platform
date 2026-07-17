/**
 * FeedingProtocolV2 sorguları (CQRS).
 * @module FeedingProtocol/Queries
 */
import { FeedingProtocolStatus } from '../entities/feeding-protocol-v2.entity';
import { ProtocolAssignmentStatus } from '../entities/protocol-assignment.entity';

export class ListFeedingProtocolsV2Query {
  constructor(
    public readonly tenantId: string,
    public readonly filter: { status?: FeedingProtocolStatus; speciesId?: string } = {},
    public readonly page: number = 1,
    public readonly limit: number = 20,
  ) {}
}

export class GetFeedingProtocolV2Query {
  constructor(
    public readonly protocolId: string,
    public readonly tenantId: string,
  ) {}
}

export class ListProtocolAssignmentsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter: {
      siteId?: string;
      unitId?: string;
      protocolId?: string;
      status?: ProtocolAssignmentStatus;
    } = {},
    public readonly page: number = 1,
    public readonly limit: number = 50,
  ) {}
}
