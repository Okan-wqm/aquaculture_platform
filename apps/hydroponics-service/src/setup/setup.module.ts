import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HydroponicsConfig } from './entities/hydroponics-config.entity';
import { SetupResolver } from './resolvers/setup.resolver';

@Module({
  imports: [TypeOrmModule.forFeature([HydroponicsConfig])],
  providers: [SetupResolver],
})
export class HydroponicsSetupModule {}
