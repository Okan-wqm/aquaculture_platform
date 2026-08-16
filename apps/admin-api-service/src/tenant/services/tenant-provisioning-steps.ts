/**
 * Canonical tenant provisioning workflow order.
 *
 * Runtime execution, durable step projection, and architectural invariants all
 * import this tuple. Adding a step anywhere else creates no executable
 * authority and therefore cannot silently change lifecycle ordering.
 */
export const TENANT_PROVISIONING_STEPS = [
  'reserve_auth_tenant',
  'begin_provisioning',
  'assign_modules',
  'publish_provisioning_requested',
  'wait_for_db_migrate_provisioner',
  'provision_application_resources',
  'create_subscription',
  'publish_onboarding_requested',
  'wait_for_onboarding_ack',
  'activate_tenant',
  'publish_tenant_provisioned',
] as const;

export type TenantProvisioningStepName = (typeof TENANT_PROVISIONING_STEPS)[number];
