import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

function listSourceFiles(path: string): string[] {
  const absolute = resolve(REPO_ROOT, path);
  const entries = readdirSync(absolute);
  const files: string[] = [];

  for (const entry of entries) {
    const childPath = `${path}/${entry}`;
    const childAbsolute = resolve(REPO_ROOT, childPath);
    const stats = statSync(childAbsolute);

    if (stats.isDirectory()) {
      if (entry === '__tests__' || entry === 'test' || entry === 'tests') {
        continue;
      }

      files.push(...listSourceFiles(childPath));
      continue;
    }

    if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.test.ts')) {
      files.push(childPath);
    }
  }

  return files;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('INVARIANT: tenant creation route SSOT', () => {
  it('exposes only operation-based tenant creation and polling routes', () => {
    const controller = readRepoFile('apps/admin-api-service/src/tenant/tenant.controller.ts');

    expect(controller).toContain("@Controller('tenants')");
    expect(controller).toContain('export class TenantPublicController');
    expect(controller).toContain('@Post()');
    expect(controller).toContain("@Get('provisioning/:operationId')");
    expect(controller).toContain("@Post('provisioning/:operationId/retry')");
    expect(controller).toContain("@Controller('admin/tenants')");
    expect(controller).toContain('export class TenantAdminController');
    expect(controller).not.toContain("@Post(':id/provision')");
    expect(controller).not.toContain("@Get(':id/provision/status')");
    expect(controller).not.toContain('provision/status');
  });

  it('keeps the public accepted response narrow and canonical', () => {
    const dto = readRepoFile('apps/admin-api-service/src/tenant/dto/tenant.dto.ts');
    const workflow = readRepoFile(
      'apps/admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts',
    );
    const adminPanelApi = readRepoFile('web/modules/admin-panel/src/services/api/tenants.ts');
    const adminPanelType = readRepoFile('web/modules/admin-panel/src/services/types/tenant.ts');
    const createPage = readRepoFile('web/modules/admin-panel/src/pages/CreateTenantPage.tsx');

    const responseContract = dto.slice(
      dto.indexOf('export class CreateTenantAcceptedResponse'),
      dto.indexOf('export class UpdateTenantDto'),
    );
    expect(responseContract).toContain('status!: TenantProvisioningState');
    expect(responseContract).toContain('tenantStatus?: TenantStatus');
    expect(responseContract).toContain('statusUrl!: string');
    expect(responseContract).toContain('retryAfterMs!: number');
    expect(responseContract).toContain('availableActions!: string[]');
    expect(responseContract).not.toContain('provisioningState');
    expect(responseContract).not.toContain('operationId');
    expect(responseContract).not.toContain('tenantId');
    expect(workflow).toContain('status: run.state');
    expect(workflow).toContain('statusUrl: `/tenants/provisioning/${run.id}`');
    expect(workflow).not.toContain('provisioningState: run.state');
    expect(adminPanelApi).not.toContain("startsWith('/api/v1/')");
    expect(adminPanelApi).not.toContain("startsWith('/api/')");
    expect(adminPanelApi).not.toContain("startsWith('/v1/')");
    expect(adminPanelApi).toContain('apiFetch<CreateTenantAcceptedResponse>(`${endpoint}/retry`');
    expect(adminPanelType).not.toContain('provisioningState: TenantProvisioningState');
    expect(createPage).toContain('provisioningOperation.status');
    expect(createPage).not.toContain('provisioningOperation.provisioningState');
    expect(createPage).toContain('retryAfterMs must be positive');
  });

  it('makes provisioning retry idempotent for non-terminal operations', () => {
    const workflow = readRepoFile(
      'apps/admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts',
    );

    expect(workflow).toContain("this.dataSource.transaction('SERIALIZABLE'");
    expect(workflow).toContain('FOR UPDATE');
    expect(workflow).toContain('current.state === TenantProvisioningState.QUEUED');
    expect(workflow).toContain('current.state === TenantProvisioningState.RUNNING');
    expect(workflow).toContain('return current');
    expect(workflow).toContain('let shouldProcess = false');
    expect(workflow).toContain('Succeeded tenant provisioning operations cannot be retried');
  });

  it('does not expose auth-service GraphQL createTenant as an external create path', () => {
    const resolver = readRepoFile(
      'apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts',
    );

    expect(resolver).not.toMatch(/@Mutation\(\(\s*=>\s*Tenant\)[\s\S]{0,200}async createTenant\(/);
  });
});

describe('INVARIANT: auth-service owns tenant lifecycle commands', () => {
  it('declares canonical request.auth.tenant command subjects with no legacy tenant.commands namespace', () => {
    const contracts = readRepoFile('libs/event-contracts/src/tenant-commands.ts');

    for (const subject of [
      'request.auth.tenant.ReserveTenant',
      'request.auth.tenant.SetupRoles',
      'request.auth.tenant.AssignModules',
      'request.auth.tenant.CreateFirstAdminInvite',
      'request.auth.tenant.ActivateTenant',
      'request.auth.tenant.FailProvisioning',
      'request.auth.tenant.DeprovisionTenant',
      'request.auth.tenant.RollbackProvisioning',
    ]) {
      expect(contracts).toContain(subject);
    }

    expect(contracts).not.toContain('tenant.commands.');
    expect(contracts).toContain('operationId: string');
    expect(contracts).toContain('requestReference?: string');
    expect(contracts).not.toContain('idempotencyKey: string');
    expect(contracts).not.toContain('idempotencyKey?: string');
    expect(contracts).not.toContain('payloadHash: string');
    expect(contracts).not.toContain('payloadHash?: string');
    expect(contracts).not.toContain('AuthTenantAllowedTransition');
    expect(contracts).not.toContain('allowedTransition?: AuthTenantAllowedTransition');
    expect(contracts).not.toContain('targetStatus?:');
  });

  it('registers auth-service NATS handlers for the canonical lifecycle subjects', () => {
    const handler = readRepoFile(
      'apps/auth-service/src/modules/tenant/handlers/auth-admin-nats.handler.ts',
    );

    for (const constant of [
      'RESERVE_TENANT',
      'SETUP_TENANT_ROLES',
      'ASSIGN_TENANT_MODULES',
      'CREATE_FIRST_ADMIN_INVITE',
      'ACTIVATE_TENANT',
      'FAIL_PROVISIONING',
      'DEPROVISION_TENANT',
      'ROLLBACK_TENANT_PROVISIONING',
    ]) {
      expect(handler).toContain(`@MessagePattern(TENANT_COMMAND_SUBJECTS.${constant})`);
    }
  });

  it('persists auth tenant command receipts for idempotency and payload-hash conflict checks', () => {
    const migration = readRepoFile(
      'apps/auth-service/src/migrations/1800100000000-TenantCommandReceiptLedger.ts',
    );
    const service = readRepoFile(
      'apps/auth-service/src/modules/tenant/services/tenant-provisioning-command.service.ts',
    );

    expect(migration).toContain('"auth"."tenant_command_receipts"');
    expect(migration).toContain('"operationId"');
    expect(migration).toContain('"tenantId"');
    expect(migration).toContain('"commandType"');
    expect(migration).toContain('"idempotencyKey"');
    expect(migration).toContain('uk_tenant_command_receipts_operation_tenant_command_idem');
    expect(migration).toContain('"payloadHash" VARCHAR(64) NOT NULL');
    expect(migration).toContain('"resultSummary" JSONB NULL');
    expect(migration).toContain('DROP COLUMN IF EXISTS "resultPayload"');
    expect(service).toContain('runWithReceipt');
    expect(service).toContain('hashCommandPayload');
    expect(service).toContain('receiptIdempotencyKey');
    expect(service).toContain('resultSummary');
    expect(service).toContain('idempotency key was reused with a different payload');
  });

  it('owns lifecycle legality via the canonical machine + command authorization, not a local copy or caller metadata', () => {
    const service = readRepoFile(
      'apps/auth-service/src/modules/tenant/services/tenant-provisioning-command.service.ts',
    );

    // W3.3-c: edge legality is delegated to the canonical TenantStatusMachine
    // (assertTransition); the local LIFECYCLE_COMMANDS map only narrows command
    // authorization (a subset of the machine's edges, never a parallel legality
    // table). The drifting local legality copy is gone.
    expect(service).toContain('LIFECYCLE_COMMANDS');
    expect(service).toContain('assertTransition(tenant.status, targetStatus)');
    expect(service).toContain("from '@platform/event-contracts'");
    expect(service).not.toContain('lifecycleTransitionPolicy');
    expect(service).not.toContain('getAllowedLifecycleTransition');
    // Caller metadata never decides transitions.
    expect(service).toContain('requestReference: _requestReference');
    expect(service).not.toContain('command.allowedTransition?.from ?? defaultFrom');
    expect(service).not.toContain('command.allowedTransition');
    expect(service).not.toContain('command.targetStatus');
  });

  it('wires the BeginProvisioning lifecycle command end-to-end so PROVISIONING is a real phase', () => {
    const contracts = readRepoFile('libs/event-contracts/src/tenant-commands.ts');
    const handler = readRepoFile(
      'apps/auth-service/src/modules/tenant/handlers/auth-admin-nats.handler.ts',
    );
    const service = readRepoFile(
      'apps/auth-service/src/modules/tenant/services/tenant-provisioning-command.service.ts',
    );
    const client = readRepoFile(
      'apps/admin-api-service/src/tenant/services/auth-tenant-provisioning-client.service.ts',
    );
    const workflow = readRepoFile(
      'apps/admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts',
    );

    // Canonical subject + command type.
    expect(contracts).toContain("BEGIN_PROVISIONING: 'request.auth.tenant.BeginProvisioning'");
    expect(contracts).toContain('BeginProvisioningCommand');
    // auth-service is the sole writer: NATS handler -> command-service handler.
    expect(handler).toContain('TENANT_COMMAND_SUBJECTS.BEGIN_PROVISIONING');
    expect(handler).toContain('beginProvisioning(command)');
    expect(service).toContain('async beginProvisioning(');
    // admin-api stays a pure NATS client and inserts the PENDING->PROVISIONING
    // step between reserve and the provisioning work.
    expect(client).toContain('TENANT_COMMAND_SUBJECTS.BEGIN_PROVISIONING');
    expect(workflow).toContain("'begin_provisioning'");
    expect(workflow).toContain('this.beginProvisioning(run, tenant.id)');
  });

  it('routes tenant lifecycle + first-admin events through the durable outbox, not a raw event bus', () => {
    const service = readRepoFile(
      'apps/auth-service/src/modules/tenant/services/tenant-provisioning-command.service.ts',
    );

    // DATA-HIGH-001 / W3.3: the command service is the sole writer of auth tenant
    // state and emits its state-change events durably. It no longer injects the
    // raw event bus; lifecycle status changes and the first-admin invite are
    // enqueued to auth_outbox inside the SERIALIZABLE receipt transaction, so the
    // write and its event commit atomically (no fire-and-forget dual-write).
    expect(service).not.toContain("@Inject('EVENT_BUS')");
    expect(service).not.toContain('this.eventBus.publish');
    expect(service).toContain('private readonly outboxPublisher: OutboxPublisher');
    expect(service).toMatch(/this\.outboxPublisher\.enqueue\(/);
    // TenantStatusChanged is the single emission point for all five lifecycle
    // transitions, enqueued at the status-persist site in transitionTenantStatus.
    expect(service).toContain(
      "createBaseEvent<TenantStatusChangedEvent>('TenantStatusChanged'",
    );
    // First-admin UserInvited is durable + atomic with the user/invitation write.
    expect(service).toContain('enqueueFirstAdminInvite');
  });

  it('does not send caller-owned receipt keys or payload hashes from admin auth-command facades', () => {
    const files = [
      'apps/admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts',
      'apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts',
      'apps/admin-api-service/src/tenant/services/tenant-detail.service.ts',
      'apps/admin-api-service/src/tenant/handlers/suspend-tenant.handler.ts',
      'apps/admin-api-service/src/modules/modules.service.ts',
      'apps/admin-api-service/src/modules/tenant-management/services/module-assignment.service.ts',
    ];

    for (const file of files) {
      const source = stripComments(readRepoFile(file));
      expect(source).not.toMatch(
        /authProvisioningClient\.\w+\(\{[\s\S]{0,1200}\b(?:idempotencyKey|payloadHash|allowedTransition|targetStatus)\s*:/,
      );
    }
  });

  it('does not let admin-api or auth GraphQL bypass tenant command receipts', () => {
    const updateHandler = readRepoFile(
      'apps/admin-api-service/src/tenant/handlers/update-tenant.handler.ts',
    );
    const resolver = readRepoFile(
      'apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts',
    );

    expect(updateHandler).not.toContain('queryRunner.manager.save(tenant)');
    expect(updateHandler).not.toContain('tenantRepository.save');
    expect(updateHandler).toContain('owner-service-owned');
    expect(resolver).toContain('Tenant lifecycle is command-receipt owned');
    expect(resolver).toContain('Tenant updates are command-receipt owned');
    expect(resolver).not.toContain('return this.tenantService.suspend(id)');
    expect(resolver).not.toContain('return this.tenantService.activate(id)');
    expect(resolver).not.toContain('return this.tenantService.cancel(id)');
  });
});

describe('INVARIANT: billing provisioning is confirmed by owner receipt evidence', () => {
  it('uses billing-service request-reply command receipts instead of subscription-requested outbox enqueue', () => {
    const contracts = readRepoFile('libs/event-contracts/src/billing-admin-commands.ts');
    const migration = readRepoFile(
      'apps/billing-service/src/database/migrations/1800400000000-BillingCommandReceipts.ts',
    );
    const billingModule = readRepoFile('apps/billing-service/src/billing/billing.module.ts');
    const billingHandler = readRepoFile(
      'apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts',
    );
    const workflow = readRepoFile(
      'apps/admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts',
    );

    expect(contracts).toContain('PROVISION_TENANT_SUBSCRIPTION');
    expect(contracts).toContain('request.billing.tenant.provisionSubscription');
    expect(contracts).toContain('operationId: string');
    expect(contracts).toContain('idempotencyKey: string');
    expect(migration).toContain('"billing"."command_receipts"');
    expect(migration).toContain('uk_billing_command_receipts_operation_tenant_command_idem');
    expect(billingHandler).toContain(
      '@MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.PROVISION_TENANT_SUBSCRIPTION)',
    );
    expect(billingHandler).toContain("this.dataSource.transaction('SERIALIZABLE'");
    expect(billingHandler).toContain('prepareBillingReceipt');
    expect(billingHandler).toContain('createProvisioningSubscription');
    expect(billingHandler).toContain('assertActiveSubscriptionReplayMatches');
    expect(billingHandler).toContain(
      'Active billing subscription exists but its module digest does not match',
    );
    expect(billingHandler).toContain('markBillingReceiptSucceeded');
    expect(billingHandler).toContain(
      'Enterprise provisioning requires an approved billing quote or custom plan',
    );
    expect(billingHandler).toContain('Billing catalog version mismatch');
    const receiptIndex = billingHandler.indexOf('const receipt = await this.prepareBillingReceipt');
    const createSubscriptionIndex = billingHandler.indexOf(
      'const subscription = await this.createProvisioningSubscription',
    );
    const successAfterCreateIndex = billingHandler.indexOf(
      'return this.markBillingReceiptSucceeded(manager, command, receipt.id',
      createSubscriptionIndex,
    );
    expect(receiptIndex).toBeLessThan(createSubscriptionIndex);
    expect(createSubscriptionIndex).toBeLessThan(successAfterCreateIndex);
    expect(workflow).toContain('provisionTenantSubscription');
    expect(workflow).toContain(
      'Billing provisioning completed without subscription receipt evidence',
    );
    expect(workflow.indexOf("'create_subscription'")).toBeLessThan(
      workflow.indexOf("'activate_tenant'"),
    );
    expect(workflow.indexOf("'activate_tenant'")).toBeLessThan(
      workflow.indexOf("'publish_tenant_provisioned'"),
    );
    expect(billingModule).not.toContain('TenantSubscriptionRequestedHandler');
  });
});

describe('INVARIANT: notification commands have real consumers and ACL parity', () => {
  it('boots notification-service NATS command consumers for all canonical outbound channels', () => {
    const contracts = readRepoFile('libs/event-contracts/src/notification-commands.ts');
    const main = readRepoFile('apps/notification-service/src/main.ts');
    const handler = readRepoFile(
      'apps/notification-service/src/notification/event-handlers/notification-command.handler.ts',
    );
    const taskHandler = readRepoFile(
      'apps/notification-service/src/notification/event-handlers/task-event.handler.ts',
    );
    const module = readRepoFile(
      'apps/notification-service/src/notification/notification.module.ts',
    );
    const dispatcher = readRepoFile(
      'apps/notification-service/src/notification/services/notification-dispatcher.service.ts',
    );
    const receiptMigrationPath = listSourceFiles(
      'apps/notification-service/src/database/migrations',
    ).find((path) => path.endsWith('-CreateNotificationCommandReceipts.ts'));
    expect(receiptMigrationPath).toBeDefined();
    if (!receiptMigrationPath) {
      throw new Error('Notification command receipt migration is missing');
    }
    const receiptMigration = readRepoFile(receiptMigrationPath);
    const natsConf = readRepoFile('infrastructure/docker/nats/nats.conf');
    const serviceAcl = readRepoFile('infrastructure/nats/services.yaml');

    for (const subject of ['commands.notification.sendEmail', 'commands.notification.sendPush']) {
      expect(contracts).toContain(subject);
      expect(natsConf).toContain(subject);
      expect(serviceAcl).toContain(subject);
    }

    expect(contracts).not.toContain('commands.notification.sendSms');
    expect(contracts).not.toContain('commands.notification.sendWebhook');
    expect(natsConf).not.toContain('commands.notification.sendSms');
    expect(natsConf).not.toContain('commands.notification.sendWebhook');
    expect(serviceAcl).not.toContain('commands.notification.sendSms');
    expect(serviceAcl).not.toContain('commands.notification.sendWebhook');

    for (const constant of ['SEND_EMAIL', 'SEND_PUSH']) {
      expect(handler).toContain(`@MessagePattern(NOTIFICATION_COMMAND_SUBJECTS.${constant})`);
    }

    expect(main).toContain("natsTransport: { queue: 'notification-service' }");
    expect(module).toContain('NotificationCommandHandler');
    expect(receiptMigration).toContain('"notification"."command_receipts"');
    expect(receiptMigration).toContain('uk_notification_command_receipts_tenant_channel_reference');
    expect(dispatcher).toContain('claimCommandReceipt');
    expect(dispatcher).toContain('recipientLogRef?: string');
    expect(handler).toContain('logRef: `userId:${userId}`');
    expect(handler).toContain('resolveTenantContactRef');
    expect(handler).toContain("audience: 'hr-service'");
    expect(taskHandler).toContain('dispatchCommandNotification');
    expect(taskHandler).toContain('recipientLogRef: `userId:${userId}`');
    expect(taskHandler).not.toContain('sendTaskPush');
    expect(dispatcher.indexOf('const receipt = await this.claimCommandReceipt')).toBeLessThan(
      dispatcher.indexOf('const externalId = await this.sendNotification'),
    );
    expect(dispatcher).toContain('markCommandReceiptSucceeded');
    expect(dispatcher).toContain('Redis rate-limit check failed in production');
    expect(dispatcher).toContain('Notification rate limiter is not configured');
  });

  it('uses recipient and template references instead of raw delivery payloads', () => {
    const contracts = readRepoFile('libs/event-contracts/src/notification-commands.ts');
    const handler = readRepoFile(
      'apps/notification-service/src/notification/event-handlers/notification-command.handler.ts',
    );

    expect(contracts).toContain('recipientRef: NotificationRecipientRef');
    expect(contracts).toContain('templateId: string');
    expect(contracts).toContain('templateVersion: string');
    expect(contracts).toContain('requestReference: string');
    expect(contracts).not.toContain('recipient: NotificationRecipientRef');
    expect(contracts).not.toContain('subject?: string');
    expect(contracts).not.toContain('body?: string');
    expect(contracts).not.toContain('html?: string');
    expect(contracts).not.toContain('text?: string');
    expect(handler).toContain('command.recipientRef');
    expect(handler).toContain(
      'Notification command recipientRef must not contain raw recipient material',
    );
    expect(handler).not.toContain('command.template.body');
    expect(handler).not.toContain('template.body');
  });
});

describe('INVARIANT: platform event registry is the lifecycle SSOT', () => {
  it('registers tenant lifecycle, owner commands, notification commands, WQ critical, and sensor delete events', () => {
    const registry = readRepoFile('libs/event-contracts/src/platform-event-registry.ts');
    const index = readRepoFile('libs/event-contracts/src/index.ts');

    for (const entry of [
      'TenantOnboardingRequested',
      'TenantOnboardingAck',
      'TenantOnboardingFailed',
      'TenantProvisioned',
      'TenantCreated',
      'ReserveTenant',
      'ProvisionTenantSubscription',
      'NotificationSendEmail',
      'NotificationSendPush',
      'WaterQualityCritical',
      'SensorDeleted',
      'SensorDeprovisioned',
    ]) {
      expect(registry).toContain(entry);
    }

    for (const field of [
      'subject',
      'producer',
      'consumers',
      'schema',
      'fixture',
      'acl',
      'piiClass',
      'durability',
      'backendOnly',
      'retention',
    ]) {
      expect(registry).toContain(field);
    }

    expect(registry).toContain('aliasExpiresAt');
    expect(index).toContain("export * from './platform-event-registry'");
  });

  it('orders onboarding ack before final tenant provisioned aliases', () => {
    const workflow = readRepoFile(
      'apps/admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts',
    );
    const migration = readRepoFile(
      'apps/admin-api-service/src/migrations/1800400000000-TenantProvisioningWorkflow.ts',
    );
    const farmHandler = readRepoFile(
      'apps/farm-service/src/water-quality/event-handlers/tenant-onboarding.event-handler.ts',
    );
    const tenantEvents = readRepoFile('libs/event-contracts/src/tenant-events.ts');

    expect(tenantEvents).toContain("eventType: 'TenantOnboardingRequested'");
    expect(tenantEvents).toContain("eventType: 'TenantOnboardingAck'");
    expect(tenantEvents).toContain("eventType: 'TenantOnboardingFailed'");
    expect(workflow.indexOf("'publish_onboarding_requested'")).toBeLessThan(
      workflow.indexOf("'wait_for_onboarding_ack'"),
    );
    expect(workflow.indexOf("'wait_for_onboarding_ack'")).toBeLessThan(
      workflow.indexOf("'publish_tenant_provisioned'"),
    );
    expect(workflow).toContain('TENANT_ONBOARDING_REQUIRED_SERVICES');
    expect(migration).toContain('"admin"."tenant_onboarding_acks"');
    expect(farmHandler).toContain("subscribeWildcard('TenantOnboardingRequested'");
    expect(farmHandler).toContain(
      "createBaseEvent<TenantOnboardingFailedEvent>('TenantOnboardingFailed'",
    );
    expect(farmHandler).toContain("createBaseEvent('TenantOnboardingAck'");
  });
});

describe('INVARIANT: remediated admin tenant runtime files do not write auth.tenants directly', () => {
  for (const file of [
    'apps/admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts',
    'apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts',
    'apps/admin-api-service/src/tenant/services/tenant-detail.service.ts',
    'apps/admin-api-service/src/tenant/handlers/suspend-tenant.handler.ts',
  ]) {
    it(`${file} delegates auth tenant status writes`, () => {
      const source = readRepoFile(file);

      expect(source).not.toMatch(/UPDATE\s+auth\.tenants/i);
      expect(source).not.toMatch(/INSERT\s+INTO\s+auth\.tenants/i);
      expect(source).not.toMatch(/DELETE\s+FROM\s+auth\.tenants/i);
      expect(source).toContain('authProvisioningClient');
    });
  }

  it('does not register the legacy synchronous CreateTenantHandler in TenantManagementModule', () => {
    const module = readRepoFile('apps/admin-api-service/src/tenant/tenant.module.ts');

    expect(module).not.toContain('CreateTenantHandler');
  });
});

describe('INVARIANT: admin-api does not directly write auth or billing owned tables', () => {
  it('contains no runtime INSERT/UPDATE/DELETE against auth.* or billing.* tables', () => {
    const offenders: string[] = [];

    for (const file of listSourceFiles('apps/admin-api-service/src')) {
      const source = stripComments(readRepoFile(file));
      const matches = source.match(
        /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:auth|billing)\.[a-zA-Z_][\w]*/gi,
      );

      if (matches?.length) {
        offenders.push(`${file}: ${matches.join(', ')}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('INVARIANT: admin-api runtime code does not execute tenant schema DDL directly', () => {
  it('contains no runtime CREATE SCHEMA or DROP SCHEMA SQL outside shared SchemaManagerService', () => {
    const offenders: string[] = [];

    for (const file of listSourceFiles('apps/admin-api-service/src')) {
      if (file.includes('/migrations/')) {
        continue;
      }

      const source = stripComments(readRepoFile(file));
      const matches = source.match(/\b(?:CREATE|DROP)\s+SCHEMA\b/gi);

      if (matches?.length) {
        offenders.push(`${file}: ${matches.join(', ')}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps database-management schema mutations fail-closed under db-migrate authority', () => {
    const schemaManagement = stripComments(
      readRepoFile(
        'apps/admin-api-service/src/database-management/services/schema-management.service.ts',
      ),
    );
    expect(schemaManagement).toContain('Runtime tenant schema creation is disabled');
    expect(schemaManagement).toContain('Runtime admin.tenant_schemas status writes are disabled');
    expect(schemaManagement).toContain('Runtime schema deletion is disabled');
    expect(schemaManagement).toContain('completed by aqua-db-migrate');
    expect(schemaManagement).not.toMatch(
      /\bschemaRepository\.(?:save|insert|update|delete|remove)\s*\(/,
    );
    expect(schemaManagement).not.toContain('SchemaManagerService');
    expect(schemaManagement).not.toContain('DEFAULT_TENANT_MODULES');
  });
});

describe('INVARIANT: admin surfaces do not carry raw invite or reset token material', () => {
  it('does not expose raw invite/reset token fields or URLs in admin-api or admin-panel runtime code', () => {
    const offenders: string[] = [];

    for (const root of ['apps/admin-api-service/src', 'web/modules/admin-panel/src']) {
      for (const file of listSourceFiles(root)) {
        if (file.includes('/migrations/')) {
          continue;
        }

        const source = stripComments(readRepoFile(file));
        const matches = source.match(
          /\b(?:invitationToken|inviteToken|resetToken|passwordResetToken|rawToken|resetUrl|inviteUrl)\b/g,
        );

        if (matches?.length) {
          offenders.push(`${file}: ${matches.join(', ')}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps tenant-admin invite command results tokenless and delivery-event based', () => {
    const contracts = readRepoFile('libs/event-contracts/src/tenant-commands.ts');
    const handler = readRepoFile(
      'apps/auth-service/src/modules/tenant/handlers/auth-admin-nats.handler.ts',
    );
    const lifecycle = readRepoFile(
      'apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts',
    );
    const actionTokenEntity = readRepoFile(
      'apps/auth-service/src/modules/authentication/entities/action-token.entity.ts',
    );
    const internalAuth = readRepoFile(
      'apps/auth-service/src/modules/authentication/controllers/internal-auth.controller.ts',
    );

    const resultContract = contracts.slice(
      contracts.indexOf('export interface AdminInviteUserResult'),
      contracts.indexOf('export interface AdminCheckUserLimitQuery'),
    );

    expect(resultContract).not.toContain('invitationToken');
    expect(resultContract).toContain('deliveryStatus');
    expect(handler).not.toMatch(/invitationToken\s*:/);
    // DATA-HIGH-001: the lifecycle service publishes the tokenless UserInvited
    // delivery event through the allowlisted BestEffortEventPublisher, NOT the
    // raw event bus. Asserting `bestEffort.publish` (and forbidding a raw
    // `this.eventBus.publish`) locks the durable-discipline routing in place.
    expect(lifecycle).toContain('bestEffort.publish(event)');
    expect(lifecycle).not.toMatch(/this\.eventBus\.publish/);
    expect(lifecycle).toContain('actionTokenId: result.actionTokenId');
    expect(lifecycle).not.toContain('actionTokenId: tokenHash');
    expect(actionTokenEntity).toContain("@Entity('action_tokens', { schema: 'auth' })");
    expect(actionTokenEntity).toContain('purpose!: ActionTokenPurpose');
    expect(actionTokenEntity).toContain('tokenHash!: string');
    expect(internalAuth).toMatch(/where:\s*\{\s*id:\s*actionTokenId\b/);
    // SEC-HIGH-056: the link is built by the one resolver, from the row id.
    expect(internalAuth).toContain('actionTokenResolver.buildActionUrl(');
    expect(
      readRepoFile(
        'apps/auth-service/src/modules/authentication/services/action-token-resolver.service.ts',
      ),
    ).toContain('${actionToken.id}');
  });
});

describe('INVARIANT: destructive tenant schema cleanup requires workflow proof', () => {
  it('requires CleanupDropProof at the shared deleteTenantSchema boundary', () => {
    const schemaManager = readRepoFile(
      'libs/backend-common/src/database/schema-manager.service.ts',
    );

    expect(schemaManager).toContain('export interface CleanupDropProof');
    expect(schemaManager).toContain('purpose: CleanupDropProofPurpose');
    expect(schemaManager).toContain('proof: CleanupDropProof');
    expect(schemaManager).toContain('assertCleanupDropProof(proof, tenantId)');
    expect(schemaManager).toContain('CleanupDropProof requires legal-hold evidence');
    expect(schemaManager).toContain('CleanupDropProof requires encrypted backup evidence');
  });

  it('keeps SchemaManagerService schema deletion fail-closed under db-migrate authority', () => {
    const schemaManager = readRepoFile(
      'libs/backend-common/src/database/schema-manager.service.ts',
    );
    const dropMatches = [...schemaManager.matchAll(/DROP\s+SCHEMA\s+IF\s+EXISTS/gi)];

    expect(dropMatches).toHaveLength(0);
    // async is optional in the pattern: the guard ALWAYS throws (fail-closed),
    // so the lint-clean shape is a synchronous method — the invariant's
    // load-bearing clauses are the proof assertion and db-migrate authority,
    // not the method's asyncness.
    expect(schemaManager).toMatch(
      /private\s+(?:async\s+)?dropTenantSchema[\s\S]+assertCleanupDropProof\(proof,\s*tenantId\)[\s\S]+aqua-db-migrate/,
    );
    expect(schemaManager).toContain(
      'runtime services must write a cleanup request ledger entry instead',
    );
  });

  it('mints rollback and deprovision proofs before admin cleanup callers delete schemas', () => {
    const provisioning = readRepoFile(
      'apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts',
    );
    const provisionerSql = readRepoFile(
      'apps/db-migrate/src/sql/platform-bootstrap/009-tenant-schema-provisioner.sql',
    );
    const provisionerWorker = readRepoFile('apps/db-migrate/src/tenant-schema-provisioner.ts');
    const backupController = readRepoFile(
      'apps/admin-api-service/src/database-management/controllers/backup.controller.ts',
    );
    const backupService = readRepoFile(
      'apps/admin-api-service/src/database-management/services/backup-restore.service.ts',
    );
    const adminPanelDbApi = readRepoFile('web/modules/admin-panel/src/services/api/database.ts');

    expect(provisioning).toContain("purpose: 'provisioning_rollback'");
    expect(provisioning).toContain("purpose: 'tenant_deprovision'");
    expect(provisioning).toContain('legalHoldCheckedAt');
    expect(provisioning).toContain('backup: {');
    expect(provisioning).toContain('isEncrypted: true');
    expect(provisioning).toContain("'PENDING_DB_MIGRATE'");
    expect(provisioning).toContain("schemaRecord.status = 'pending_deletion';");
    expect(provisioning).toContain('platform.request_tenant_schema_deletion');
    expect(provisioning).toContain('serializeCleanupDropProof');
    expect(provisionerSql).toContain('Tenant schema deletion requires cleanupProof evidence');
    expect(provisionerSql).toContain('Tenant schema deletion requires encrypted backup evidence');
    expect(
      provisionerSql.split('CREATE OR REPLACE FUNCTION platform.request_tenant_schema_deletion')[0],
    ).not.toContain('Tenant schema deletion requires cleanupProof evidence');
    expect(
      provisionerSql.split('CREATE OR REPLACE FUNCTION platform.request_tenant_schema_deletion')[1],
    ).toContain('Tenant schema deletion requires cleanupProof evidence');
    expect(provisionerSql).toContain(
      'GRANT EXECUTE ON FUNCTION platform.request_tenant_schema_deletion(UUID, UUID, TEXT, JSONB) TO admin_service',
    );
    expect(provisionerSql).not.toContain(
      'GRANT EXECUTE ON FUNCTION platform.request_tenant_schema_deletion(UUID, UUID, TEXT, JSONB) TO auth_service',
    );
    expect(provisionerWorker).toContain('assertDeleteProof(job)');
    expect(provisionerWorker).toContain('requires matching tombstone evidence');
    expect(backupController).not.toContain('skipValidation');
    expect(backupService).not.toContain('skipValidation');
    expect(adminPanelDbApi).not.toContain('skipValidation');
  });
});

describe('INVARIANT: password reset state is auth-service owned', () => {
  it('keeps admin-api password reset as a NATS facade with no auth table writes', () => {
    const controller = readRepoFile('apps/admin-api-service/src/auth/password-reset.controller.ts');

    expect(controller).toContain('AUTH_PUBLIC_COMMAND_SUBJECTS.REQUEST_PASSWORD_RESET');
    expect(controller).toContain('AUTH_PUBLIC_COMMAND_SUBJECTS.RESET_PASSWORD');
    expect(controller).not.toMatch(/UPDATE\s+auth\.users/i);
    expect(controller).not.toMatch(/UPDATE\s+auth\.refresh_tokens/i);
    expect(controller).not.toContain('passwordResetToken');
    expect(controller).not.toContain('crypto.randomBytes');
  });

  it('registers auth-service handlers for public password reset commands', () => {
    const contracts = readRepoFile('libs/event-contracts/src/tenant-commands.ts');
    const handler = readRepoFile(
      'apps/auth-service/src/modules/authentication/controllers/auth-public-nats.handler.ts',
    );
    const module = readRepoFile(
      'apps/auth-service/src/modules/authentication/authentication.module.ts',
    );

    expect(contracts).toContain('request.auth.public.requestPasswordReset');
    expect(contracts).toContain('request.auth.public.resetPassword');
    expect(handler).toContain(
      '@MessagePattern(AUTH_PUBLIC_COMMAND_SUBJECTS.REQUEST_PASSWORD_RESET)',
    );
    expect(handler).toContain('@MessagePattern(AUTH_PUBLIC_COMMAND_SUBJECTS.RESET_PASSWORD)');
    expect(module).toContain('AuthPublicNatsHandler');
  });
});

describe('INVARIANT: auth module catalog writes are auth-service owned', () => {
  it('delegates admin-api module catalog mutations to auth-service', () => {
    const modulesService = readRepoFile('apps/admin-api-service/src/modules/modules.service.ts');

    expect(modulesService).toContain('AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_MODULE');
    expect(modulesService).toContain('AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_MODULE');
    expect(modulesService).toContain('AUTH_ADMIN_COMMAND_SUBJECTS.DELETE_MODULE');
    expect(modulesService).not.toMatch(/INSERT\s+INTO\s+auth\.modules/i);
    expect(modulesService).not.toMatch(/UPDATE\s+auth\.modules/i);
    expect(modulesService).not.toMatch(/DELETE\s+FROM\s+auth\.modules/i);
  });

  it('registers auth-service handlers for module catalog mutation commands', () => {
    const contracts = readRepoFile('libs/event-contracts/src/tenant-commands.ts');
    const handler = readRepoFile(
      'apps/auth-service/src/modules/tenant/handlers/auth-admin-nats.handler.ts',
    );

    expect(contracts).toContain('request.auth.admin.createModule');
    expect(contracts).toContain('request.auth.admin.updateModule');
    expect(contracts).toContain('request.auth.admin.deleteModule');
    expect(handler).toContain('@MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_MODULE)');
    expect(handler).toContain('@MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_MODULE)');
    expect(handler).toContain('@MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.DELETE_MODULE)');
  });
});
