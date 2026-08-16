import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EquipmentModule } from '../equipment/equipment.module';
import { FeedModule } from '../feed/feed.module';
import { FinanceModule } from '../finance/finance.module';
import { RegulatoryModule } from '../regulatory/regulatory.module';
import { SpeciesModule } from '../species/species.module';
import { WaterQualityModule } from '../water-quality/water-quality.module';
import { TenantOnboardingReceipt } from './entities/tenant-onboarding-receipt.entity';
import { TenantOnboardingEventHandler } from './handlers/tenant-onboarding.event-handler';
import { TenantOnboardingReceiptService } from './services/tenant-onboarding-receipt.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([TenantOnboardingReceipt]),
    WaterQualityModule,
    SpeciesModule,
    FeedModule,
    RegulatoryModule,
    EquipmentModule,
    FinanceModule,
  ],
  providers: [TenantOnboardingReceiptService, TenantOnboardingEventHandler],
})
export class TenantOnboardingModule {}
