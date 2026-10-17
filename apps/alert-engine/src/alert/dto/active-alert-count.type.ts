import { Field, Int, ObjectType } from '@nestjs/graphql';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';

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
 * WHAT: one row per (severity, acknowledged) pair that has active alarms; a
 * pair without any is absent, i.e. zero.
 */
@ObjectType()
export class ActiveAlertCount {
  @Field(() => AlertSeverity)
  severity!: AlertSeverity;

  @Field()
  acknowledged!: boolean;

  @Field(() => Int)
  count!: number;
}
