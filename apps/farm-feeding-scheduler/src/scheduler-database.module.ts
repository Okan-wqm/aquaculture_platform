import { createServiceTypeOrmConfig } from '@aquaculture/backend-common/database';
import { Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import { FARM_FEEDING_SCHEDULER_DATABASE_ROLE } from '@platform/service-catalog';
import { DataSource } from 'typeorm';

import { FeedingSchedulerApplicationModule } from './scheduler-application-authority';
interface SchedulerConnectionIdentityRow {
  readonly currentUser: string;
  readonly sessionUser: string;
  readonly canLogin: boolean;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
}

/** Refuses a shared, inherited, owner, superuser or BYPASSRLS credential. */
@Injectable()
export class FeedingSchedulerConnectionAuthority implements OnApplicationBootstrap {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    const rows: SchedulerConnectionIdentityRow[] = await this.dataSource.query(
      `SELECT current_user AS "currentUser", session_user AS "sessionUser",
              role.rolcanlogin AS "canLogin", role.rolsuper AS superuser,
              role.rolbypassrls AS "bypassRls"
         FROM pg_catalog.pg_roles role
        WHERE role.rolname = current_user`,
    );
    const identity = rows[0];
    if (
      !identity ||
      identity.currentUser !== FARM_FEEDING_SCHEDULER_DATABASE_ROLE ||
      identity.sessionUser !== FARM_FEEDING_SCHEDULER_DATABASE_ROLE ||
      identity.canLogin !== true ||
      identity.superuser !== false ||
      identity.bypassRls !== false
    ) {
      throw new Error(
        `Feeding scheduler must authenticate directly as ${FARM_FEEDING_SCHEDULER_DATABASE_ROLE}`,
      );
    }
  }
}

@FeedingSchedulerApplicationModule('database-boundary', [FeedingSchedulerConnectionAuthority])
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        ...createServiceTypeOrmConfig(configService, {
          serviceName: 'farm-feeding-scheduler',
          schema: 'farm',
          migrations: [],
          entities: [],
          defaultPoolSize: 2,
          defaultPoolMin: 0,
        }),
        autoLoadEntities: false,
        entities: [],
        migrations: [],
        migrationsRun: false,
      }),
    }),
  ],
  providers: [FeedingSchedulerConnectionAuthority],
  exports: [TypeOrmModule],
})
export class FeedingSchedulerDatabaseModule {}
