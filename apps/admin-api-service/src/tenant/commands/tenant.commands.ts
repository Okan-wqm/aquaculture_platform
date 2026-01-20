import {
  CreateTenantDto,
  UpdateTenantDto,
  SuspendTenantDto,
} from '../dto/tenant.dto';

export class CreateTenantCommand {
  constructor(
    public readonly data: CreateTenantDto,
    public readonly createdBy: string,
  ) {}
}

export class UpdateTenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly data: UpdateTenantDto,
    public readonly updatedBy: string,
  ) {}
}

export class SuspendTenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly data: SuspendTenantDto,
    public readonly suspendedBy: string,
  ) {}
}

export class ActivateTenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly activatedBy: string,
  ) {}
}

export class DeactivateTenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly reason: string,
    public readonly deactivatedBy: string,
  ) {}
}

export class ArchiveTenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly archivedBy: string,
  ) {}
}

export class UpdateTenantLimitsCommand {
  constructor(
    public readonly tenantId: string,
    public readonly limits: {
      maxUsers?: number;
      maxFarms?: number;
      maxPonds?: number;
      maxSensors?: number;
      maxAlertRules?: number;
      dataRetentionDays?: number;
      apiRateLimit?: number;
      storageGb?: number;
    },
    public readonly updatedBy: string,
  ) {}
}

export class UpdateTenantTierCommand {
  constructor(
    public readonly tenantId: string,
    public readonly tier: string,
    public readonly updatedBy: string,
  ) {}
}

export class ExtendTenantTrialCommand {
  constructor(
    public readonly tenantId: string,
    public readonly additionalDays: number,
    public readonly extendedBy: string,
  ) {}
}

export class InviteUserToTenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly email: string,
    public readonly role: string,
    public readonly invitedBy: string,
  ) {}
}
