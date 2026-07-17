/**
 * FeedingProtocolV2 komutları (CQRS).
 * @module FeedingProtocol/Commands
 */
import {
  AssignProtocolToUnitInput,
  CreateFeedingProtocolV2Input,
  UpdateFeedingProtocolV2Input,
  UpdateProtocolAssignmentInput,
} from '../dto/feeding-protocol-v2.inputs';

export class CreateFeedingProtocolV2Command {
  constructor(
    public readonly input: CreateFeedingProtocolV2Input,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

export class UpdateFeedingProtocolV2Command {
  constructor(
    public readonly input: UpdateFeedingProtocolV2Input,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

export class ArchiveFeedingProtocolV2Command {
  constructor(
    public readonly protocolId: string,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

export class AssignProtocolToUnitCommand {
  constructor(
    public readonly input: AssignProtocolToUnitInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

/** Plan §1.2 kolaylık komutu: batch'in GÜNCEL ünitelerine toplu atama. */
export class AssignProtocolToBatchUnitsCommand {
  constructor(
    public readonly batchId: string,
    public readonly protocolId: string,
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly speciesMismatchReason?: string,
  ) {}
}

export class UpdateProtocolAssignmentCommand {
  constructor(
    public readonly input: UpdateProtocolAssignmentInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

export class UnassignProtocolCommand {
  constructor(
    public readonly assignmentId: string,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
