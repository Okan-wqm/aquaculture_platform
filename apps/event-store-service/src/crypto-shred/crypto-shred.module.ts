import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TenantPayloadKey } from './entities/tenant-payload-key.entity';
import { TenantPayloadCryptoService } from './tenant-payload-crypto.service';

/**
 * Event-store crypto-shred core (DB-INFRA-HIGH-003 Part B). Provides the
 * per-tenant payload crypto service + its DEK key store. Not yet consumed by the
 * append/read path — that wiring is gated on the security review in the design
 * doc; this module is registered so the key store migration + service are ready
 * to activate.
 */
@Module({
  imports: [TypeOrmModule.forFeature([TenantPayloadKey])],
  providers: [TenantPayloadCryptoService],
  exports: [TenantPayloadCryptoService],
})
export class CryptoShredModule {}
