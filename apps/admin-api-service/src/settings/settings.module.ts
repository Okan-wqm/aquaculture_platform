import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import {
  TenantConfiguration,
  SystemSetting,
  EmailTemplate,
  IpAccessRule,
} from './entities';

// Services
import {
  TenantConfigurationService,
  SystemSettingService,
  EmailTemplateService,
  IpAccessService,
} from './services';
import { EmailSenderService } from './services/email-sender.service';

// Controllers
import { SettingsController } from './settings.controller';
import { TenantConfigurationController } from './controllers/tenant-configuration.controller';
import { EmailTemplateController } from './controllers/email-template.controller';
import { IpAccessController } from './controllers/ip-access.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TenantConfiguration,
      SystemSetting,
      EmailTemplate,
      IpAccessRule,
    ]),
  ],
  controllers: [
    SettingsController,
    TenantConfigurationController,
    EmailTemplateController,
    IpAccessController,
  ],
  providers: [
    TenantConfigurationService,
    SystemSettingService,
    EmailTemplateService,
    IpAccessService,
    EmailSenderService,
  ],
  exports: [
    TenantConfigurationService,
    SystemSettingService,
    EmailTemplateService,
    IpAccessService,
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
    await this.systemSettingService.seedDefaultSettings();
    await this.emailTemplateService.seedDefaultTemplates();
  }
}
