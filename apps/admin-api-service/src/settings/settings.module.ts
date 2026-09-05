import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmailTemplateController } from './controllers/email-template.controller';
import { TenantConfigurationController } from './controllers/tenant-configuration.controller';
import { EmailTemplate } from './entities';
import {
  TenantConfigurationService,
  SystemSettingService,
  EmailTemplateService,
} from './services';
import { EmailSenderService } from './services/email-sender.service';
import { SettingsController } from './settings.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([EmailTemplate]),
  ],
  controllers: [
    SettingsController,
    TenantConfigurationController,
    EmailTemplateController,
  ],
  providers: [
    TenantConfigurationService,
    SystemSettingService,
    EmailTemplateService,
    EmailSenderService,
  ],
  exports: [
    TenantConfigurationService,
    SystemSettingService,
    EmailTemplateService,
    EmailSenderService,
  ],
})
export class SettingsModule implements OnModuleInit {
  constructor(
    private readonly systemSettingService: SystemSettingService,
    private readonly emailTemplateService: EmailTemplateService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Seed default settings and templates on startup
    this.systemSettingService.seedDefaultSettings();
    await this.emailTemplateService.seedDefaultTemplates();
  }
}
