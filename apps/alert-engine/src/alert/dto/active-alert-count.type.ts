import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import type { OwnerModuleCode } from '@aquaculture/shared-contracts';
import { ALERT_MODULE_ENUM } from '../entities/alert-module.enum';

/**
 * The dimensions activeAlertCounts can additionally group by.
 *
 * WHY: the workspace menu counts each module workspace's alarms (MODULE) and a
 * module dashboard counts each site's (SITE, with a module filter); both read
 * the same unresolved rows as the annunciator, only split further.
 */
export enum ActiveAlertCountDimension {
  SITE = 'site',
  MODULE = 'module',
}

registerEnumType(ActiveAlertCountDimension, {
  name: 'ActiveAlertCountDimension',
  description: 'A dimension activeAlertCounts can group the unresolved alarms by',
});

/**
 * ActiveAlertCount — how many unresolved alarms of one severity are, or are
 * not yet, acknowledged.
 *
 * WHY: the tenant console's annunciator shows the active alarms per priority
 * and, apart, the unacknowledged ones. Counted from alertHistory pages, an
 * older active CRITICAL fell off the page behind newer rows the annunciator
 * does not count (INFO feed transitions nobody acknowledges, alarms resolved
 * without acknowledgement), and every count stopped at the page size. A
 * grouped count over the unresolved rows has no page to fall off. It counts
 * by alert-engine's own severity: the severity → priority scale belongs to
 * the web (shared-ui AnnunciatorPriority), which the annunciator and the alarm
 * list both read, so the server does not keep a second copy of it.
 *
 * WHAT: one row per (severity, acknowledged) pair that has active alarms —
 * per (…, site) and/or (…, module) when grouped by those dimensions; a
 * combination without any is absent, i.e. zero. `siteId` / `module` are set
 * only when the count is grouped by them; a null there then names the alarms
 * without a site, or recorded before alarms carried a module.
 */
@ObjectType()
export class ActiveAlertCount {
  @Field(() => AlertSeverity)
  severity!: AlertSeverity;

  @Field()
  acknowledged!: boolean;

  @Field(() => ID, { nullable: true })
  siteId?: string | null;

  @Field(() => ALERT_MODULE_ENUM, { nullable: true })
  module?: OwnerModuleCode | null;

  @Field(() => Int)
  count!: number;
}
