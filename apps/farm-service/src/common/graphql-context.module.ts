import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TankBatch } from '../batch/entities/tank-batch.entity';
import { ProtocolRateService } from '../feeding-protocol/services/protocol-rate.service';
import { UnitProtocolResolverService } from '../feeding-protocol/services/unit-protocol-resolver.service';
import { GraphQLContextFactory } from './graphql-context.factory';

@Module({
  imports: [TypeOrmModule.forFeature([TankBatch])],
  // Stateless engine helpers registered as direct providers rather than by
  // importing FeedingProtocolModule — that module transitively imports
  // FeedingModule, which would close a DI cycle back through the GraphQL
  // context. Same precedent as FeedingModule/GrowthModule/BatchModule.
  providers: [GraphQLContextFactory, ProtocolRateService, UnitProtocolResolverService],
  exports: [GraphQLContextFactory],
})
export class GraphQLContextModule {}
