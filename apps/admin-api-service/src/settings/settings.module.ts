import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { EmailTemplateController } from './controllers/email-template.controller';
import { IpAccessController } from './controllers/ip-access.controller';
import { TenantConfigurationController } from './controllers/tenant-configuration.controller';
import {
  EmailTemplate,
  IpAccessRule,
} from './entities';

// Services
import {
  TenantConfigurationService,
  SystemSettingService,
  ConfigServiceAdminProxy,
  EmailTemplateService,
  IpAccessService,
} from './services';
import { EmailSenderService } from './services/email-sender.service';

// Controllers
import { SettingsController } from './settings.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
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
    ConfigServiceAdminProxy,
    EmailTemplateService,
    IpAccessService,
    EmailSenderService,
  ],
  exports: [
    TenantConfigurationService,
    SystemSettingService,
    ConfigServiceAdminProxy,
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
