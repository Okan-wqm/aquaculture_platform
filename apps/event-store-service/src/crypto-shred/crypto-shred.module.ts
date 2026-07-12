import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TenantPayloadKey } from './entities/tenant-payload-key.entity';
import { StoredEventsCryptoShredHook } from './stored-events-crypto-shred.hook';
import { TenantPayloadCryptoService } from './tenant-payload-crypto.service';

/**
 * Event-store crypto-shred core (DB-INFRA-HIGH-003 Part B). Provides the
 * per-tenant payload crypto service + its DEK key store, plus the erasure hook
 * (rollout step 2) that shreds the tenant key when the GDPR cascade erases this
 * service. The append/read-path wiring (rollout steps 3-4) remains gated on the
 * security review in the design doc.
 */
@Module({
  imports: [TypeOrmModule.forFeature([TenantPayloadKey])],
  providers: [TenantPayloadCryptoService, StoredEventsCryptoShredHook],
  exports: [TenantPayloadCryptoService, StoredEventsCryptoShredHook],
})
export class CryptoShredModule {}
