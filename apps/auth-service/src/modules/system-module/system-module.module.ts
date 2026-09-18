import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SeedService } from '../../database/seed.service';
import { User } from '../authentication/entities/user.entity';
import { PlatformCapabilityGrant } from '../tenant/entities/platform-capability-grant.entity';

import { Module as SystemModuleEntity } from './entities/module.entity';

/**
 * System Module
 *
 * Manages system-wide configurations including:
 * - Module definitions (farm, hr, seapod, etc.)
 * - Database seeding
 */
@Module({
  imports: [TypeOrmModule.forFeature([SystemModuleEntity, User, PlatformCapabilityGrant])],
  providers: [SeedService],
  exports: [TypeOrmModule, SeedService],
})
 
export class SystemModule {}
