import { parseNatsRequestTimeout } from '@aquaculture/backend-common/nats';
import {
  BadGatewayException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  TENANT_COMMAND_SUBJECTS,
  type ActivateTenantCommand,
  type ArchiveTenantLifecycleCommand,
  type BeginProvisioningCommand,
  type AssignTenantModulesCommand,
  type AssignTenantModulesResult,
  type AuthTenantCommandResult,
  type CreateTenantAdminCommand,
  type CreateTenantAdminResult,
  type DeprovisionTenantCommand,
  type FailProvisioningCommand,
  type RemoveTenantModuleCommand,
  type RemoveTenantModuleResult,
  type ReserveTenantCommand,
  type ReserveTenantResult,
  type RollbackTenantProvisioningCommand,
  type RollbackTenantProvisioningResult,
  type SetupTenantRolesCommand,
  type SetupTenantRolesResult,
  type SuspendTenantLifecycleCommand,
} from '@platform/event-contracts';
import { catchError, firstValueFrom, throwError, timeout } from 'rxjs';

const DEFAULT_AUTH_NATS_TIMEOUT_MS = 15_000;

@Injectable()
export class AuthTenantProvisioningClientService {
  private readonly logger = new Logger(AuthTenantProvisioningClientService.name);
  private readonly timeoutMs: number;

  constructor(
    @Inject('AUTH_NATS_CLIENT')
    private readonly authNatsClient: ClientProxy,
  ) {
    this.timeoutMs = parseNatsRequestTimeout(
      process.env['AUTH_NATS_TIMEOUT_MS'],
      DEFAULT_AUTH_NATS_TIMEOUT_MS,
      'AUTH_NATS_TIMEOUT_MS',
    );
  }

  async reserveTenant(command: ReserveTenantCommand): Promise<ReserveTenantResult> {
    const result = await this.sendAuthCommand<ReserveTenantCommand, ReserveTenantResult>(
      TENANT_COMMAND_SUBJECTS.RESERVE_TENANT,
      command,
    );
    return this.requireSuccess(result, 'Auth tenant reservation failed');
  }

  async setupTenantRoles(command: SetupTenantRolesCommand): Promise<SetupTenantRolesResult> {
    const result = await this.sendAuthCommand<SetupTenantRolesCommand, SetupTenantRolesResult>(
      TENANT_COMMAND_SUBJECTS.SETUP_TENANT_ROLES,
      command,
    );
    return this.requireSuccess(result, 'Auth tenant role setup failed');
  }

  async assignTenantModules(command: AssignTenantModulesCommand): Promise<AssignTenantModulesResult> {
    const result = await this.sendAuthCommand<AssignTenantModulesCommand, AssignTenantModulesResult>(
      TENANT_COMMAND_SUBJECTS.ASSIGN_TENANT_MODULES,
      command,
    );
    return this.requireSuccess(result, 'Auth tenant module assignment failed');
  }

  async createTenantAdmin(command: CreateTenantAdminCommand): Promise<CreateTenantAdminResult> {
    const result = await this.sendAuthCommand<CreateTenantAdminCommand, CreateTenantAdminResult>(
      TENANT_COMMAND_SUBJECTS.CREATE_FIRST_ADMIN_INVITE,
      command,
    );
    return this.requireSuccess(result, 'Auth tenant admin creation failed');
  }

  async beginProvisioning(command: BeginProvisioningCommand): Promise<AuthTenantCommandResult> {
    const result = await this.sendAuthCommand<BeginProvisioningCommand, AuthTenantCommandResult>(
      TENANT_COMMAND_SUBJECTS.BEGIN_PROVISIONING,
      command,
    );
    return this.requireSuccess(result, 'Auth tenant begin-provisioning failed');
  }

  async activateTenant(command: ActivateTenantCommand): Promise<AuthTenantCommandResult> {
    const result = await this.sendAuthCommand<ActivateTenantCommand, AuthTenantCommandResult>(
      TENANT_COMMAND_SUBJECTS.ACTIVATE_TENANT,
      command,
    );
    return this.requireSuccess(result, 'Auth tenant activation failed');
  }

  async failProvisioning(command: FailProvisioningCommand): Promise<AuthTenantCommandResult> {
    const result = await this.sendAuthCommand<FailProvisioningCommand, AuthTenantCommandResult>(
      TENANT_COMMAND_SUBJECTS.FAIL_PROVISIONING,
      command,
    );
    return this.requireSuccess(result, 'Auth tenant provisioning failure transition failed');
  }

  async suspendTenant(command: SuspendTenantLifecycleCommand): Promise<AuthTenantCommandResult> {
    const result = await this.sendAuthCommand<SuspendTenantLifecycleCommand, AuthTenantCommandResult>(
      TENANT_COMMAND_SUBJECTS.SUSPEND_TENANT,
      command,
    );
    return this.requireSuccess(result, 'Auth tenant suspension failed');
  }

  async deprovisionTenant(command: DeprovisionTenantCommand): Promise<AuthTenantCommandResult> {
    const result = await this.sendAuthCommand<DeprovisionTenantCommand, AuthTenantCommandResult>(
      TENANT_COMMAND_SUBJECTS.DEPROVISION_TENANT,
      command,
    );
    return this.requireSuccess(result, 'Auth tenant deprovision transition failed');
  }

  async archiveTenant(command: ArchiveTenantLifecycleCommand): Promise<AuthTenantCommandResult> {
    const result = await this.sendAuthCommand<ArchiveTenantLifecycleCommand, AuthTenantCommandResult>(
      TENANT_COMMAND_SUBJECTS.ARCHIVE_TENANT,
      command,
    );
    return this.requireSuccess(result, 'Auth tenant archive failed');
  }

  async removeTenantModule(command: RemoveTenantModuleCommand): Promise<RemoveTenantModuleResult> {
    const result = await this.sendAuthCommand<RemoveTenantModuleCommand, RemoveTenantModuleResult>(
      TENANT_COMMAND_SUBJECTS.REMOVE_TENANT_MODULE,
      command,
    );
    return this.requireSuccess(result, 'Auth tenant module removal failed');
  }

  async rollbackTenantProvisioning(
    command: RollbackTenantProvisioningCommand,
  ): Promise<RollbackTenantProvisioningResult> {
    const result = await this.sendAuthCommand<
      RollbackTenantProvisioningCommand,
      RollbackTenantProvisioningResult
    >(TENANT_COMMAND_SUBJECTS.ROLLBACK_TENANT_PROVISIONING, command);
    return this.requireSuccess(result, 'Auth tenant provisioning rollback failed');
  }

  private async sendAuthCommand<TCommand, TResult>(
    subject: string,
    command: TCommand,
  ): Promise<TResult> {
    try {
      return await firstValueFrom(
        this.authNatsClient.send<TResult, TCommand>(subject, command).pipe(
          timeout(this.timeoutMs),
          catchError((err: Error) => {
            this.logger.error(
              `NATS request failed: subject=${subject}, error=${err.message}`,
            );
            return throwError(() => err);
          }),
        ),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Timeout')) {
        throw new BadGatewayException(
          `Auth service did not respond within ${this.timeoutMs}ms`,
        );
      }
      if (message.includes('not connected') || message.includes('CONN_CLOSED')) {
        throw new ServiceUnavailableException('Auth service is currently unavailable');
      }
      if (err instanceof HttpException) throw err;
      throw new BadGatewayException(`Auth service error: ${message}`);
    }
  }

  private requireSuccess<TResult extends { success: boolean; error?: string }>(
    result: TResult,
    fallback: string,
  ): TResult {
    if (result.success) return result;
    throw new BadGatewayException(result.error ?? fallback);
  }
}
