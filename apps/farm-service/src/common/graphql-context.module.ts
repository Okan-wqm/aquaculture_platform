import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TankBatch } from '../batch/entities/tank-batch.entity';
import { GraphQLContextFactory } from './graphql-context.factory';

@Module({
  imports: [TypeOrmModule.forFeature([TankBatch])],
  providers: [GraphQLContextFactory],
  exports: [GraphQLContextFactory],
})
export class GraphQLContextModule {}
