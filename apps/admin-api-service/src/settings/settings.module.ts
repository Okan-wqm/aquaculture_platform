import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmailTemplateController } from './controllers/email-template.controller';
import { IpAccessController } from './controllers/ip-access.controller';
import { EmailTemplate, IpAccessRule } from './entities';
import { SystemSettingService, EmailTemplateService, IpAccessService } from './services';
import { EmailSenderService } from './services/email-sender.service';
import { SettingsController } from './settings.controller';

@Module({
  imports: [TypeOrmModule.forFeature([EmailTemplate, IpAccessRule])],
  controllers: [SettingsController, EmailTemplateController, IpAccessController],
  providers: [SystemSettingService, EmailTemplateService, IpAccessService, EmailSenderService],
  exports: [SystemSettingService, EmailTemplateService, IpAccessService, EmailSenderService],
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
