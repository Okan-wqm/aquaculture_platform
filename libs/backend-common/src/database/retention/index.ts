/**
 * Retention module entry point. Services import this from
 * `@aquaculture/backend-common` + register policies at module-init
 * time. The generic enforcement service iterates all registered
 * policies on the platform cron schedule (daily 03:00 UTC).
 */
export {
  registerRetentionPolicy,
  listRetentionPolicies,
  getRetentionPolicy,
  clearRetentionPolicyRegistry,
} from './retention-policy';
export type { EntityClass, RetentionPolicy, RetentionPolicyRegistration } from './retention-policy';
export { RetentionEnforcementService } from './retention-enforcement.service';
export type { RetentionEnforcementReport } from './retention-enforcement.service';
