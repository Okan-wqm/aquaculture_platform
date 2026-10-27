import { Role } from '@aquaculture/backend-common/decorators';
import type { PlatformRole } from '@aquaculture/shared-contracts';
import { Field, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import type {
  ModuleAccessReadinessReport,
  ModuleReadiness,
  RecentWriterReadiness,
  RecentWriterStatus,
  RoleCount,
} from '../services/module-access-readiness';

/**
 * The GraphQL face of the module-access readiness report (PKG-06 "Readiness"): counts only,
 * per module and role. Added in release R3 (C1: a client reads it from the release after). The
 * meaning of each count is module-access-readiness.ts's.
 */
export const RECENT_WRITER_STATUS_GRAPHQL_ENUM = Object.freeze({
  ANSWERED: 'ANSWERED',
  NOT_TRACKED: 'NOT_TRACKED',
  UNAVAILABLE: 'UNAVAILABLE',
} as const satisfies { readonly [Status in RecentWriterStatus]: Status });

registerEnumType(RECENT_WRITER_STATUS_GRAPHQL_ENUM, {
  name: 'RecentWriterReadinessStatus',
  description:
    'ANSWERED: the owner module counted. NOT_TRACKED: the module has no writer query. ' +
    'UNAVAILABLE: the owner did not answer; the count is unknown, not zero.',
});

@ObjectType('ReadinessRoleCount')
export class ReadinessRoleCount {
  @Field(() => Role)
  role!: PlatformRole;

  @Field(() => Int)
  count!: number;

  static of(count: RoleCount): ReadinessRoleCount {
    return Object.assign(new ReadinessRoleCount(), count);
  }
}

@ObjectType('RecentWriterReadiness')
export class RecentWriterReadinessView {
  @Field(() => RECENT_WRITER_STATUS_GRAPHQL_ENUM)
  status!: RecentWriterStatus;

  @Field(() => [ReadinessRoleCount], { description: 'By users.role; empty unless ANSWERED.' })
  byUserRole!: ReadinessRoleCount[];

  static of(readiness: RecentWriterReadiness): RecentWriterReadinessView {
    return Object.assign(new RecentWriterReadinessView(), {
      status: readiness.status,
      byUserRole: readiness.byUserRole.map((entry) => ReadinessRoleCount.of(entry)),
    });
  }
}

@ObjectType('ModuleReadiness')
export class ModuleReadinessView {
  @Field()
  moduleCode!: string;

  @Field(() => [ReadinessRoleCount], { description: "The members' live grants, by module role." })
  grantsByRole!: ReadinessRoleCount[];

  @Field(() => RecentWriterReadinessView, {
    description: 'Members without the grant who wrote to the module within the window.',
  })
  recentWritersWithoutGrant!: RecentWriterReadinessView;

  static of(module: ModuleReadiness): ModuleReadinessView {
    return Object.assign(new ModuleReadinessView(), {
      moduleCode: module.moduleCode,
      grantsByRole: module.grantsByRole.map((entry) => ReadinessRoleCount.of(entry)),
      recentWritersWithoutGrant: RecentWriterReadinessView.of(module.recentWritersWithoutGrant),
    });
  }
}

@ObjectType('PayrollViewerReadiness')
export class PayrollViewerReadinessView {
  @Field(() => [ReadinessRoleCount], { description: 'Who reaches payroll today, by users.role.' })
  byGlobalRole!: ReadinessRoleCount[];

  @Field(() => [ReadinessRoleCount], {
    description: 'Who reaches payroll once hr decides by grants (D6).',
  })
  byGrant!: ReadinessRoleCount[];
}

@ObjectType('ModuleAccessReadiness')
export class ModuleAccessReadinessView {
  @Field(() => Int)
  windowDays!: number;

  @Field(() => [ReadinessRoleCount], {
    description: 'Members holding no grant in any enabled owner module, by users.role.',
  })
  membersWithoutGrants!: ReadinessRoleCount[];

  @Field(() => [ModuleReadinessView])
  modules!: ModuleReadinessView[];

  @Field(() => PayrollViewerReadinessView)
  payrollViewers!: PayrollViewerReadinessView;

  static of(report: ModuleAccessReadinessReport): ModuleAccessReadinessView {
    return Object.assign(new ModuleAccessReadinessView(), {
      windowDays: report.windowDays,
      membersWithoutGrants: report.membersWithoutGrants.map((entry) =>
        ReadinessRoleCount.of(entry),
      ),
      modules: report.modules.map((module) => ModuleReadinessView.of(module)),
      payrollViewers: Object.assign(new PayrollViewerReadinessView(), {
        byGlobalRole: report.payrollViewers.byGlobalRole.map((entry) =>
          ReadinessRoleCount.of(entry),
        ),
        byGrant: report.payrollViewers.byGrant.map((entry) => ReadinessRoleCount.of(entry)),
      }),
    });
  }
}
