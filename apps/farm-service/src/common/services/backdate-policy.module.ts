/**
 * BackdatePolicyModule
 *
 * Provides the BackdatePolicyService as a re-usable cross-cutting
 * dependency. Each domain module (feeding, growth, mortality, harvest)
 * imports this module to get the backdate-validation singleton without
 * redeclaring the provider in every place.
 *
 * ConfigService is imported explicitly so the service can read the
 * per-context env overrides even when the host module has not
 * otherwise wired Nest's config plumbing.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BackdatePolicyService } from './backdate-policy.service';

@Module({
  imports: [ConfigModule],
  providers: [BackdatePolicyService],
  exports: [BackdatePolicyService],
})
export class BackdatePolicyModule {}
