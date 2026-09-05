import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmailTemplateController } from './controllers/email-template.controller';
import { EmailTemplate } from './entities';
import { SystemSettingService, EmailTemplateService } from './services';
import { EmailSenderService } from './services/email-sender.service';
import { SettingsController } from './settings.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([EmailTemplate]),
  ],
  controllers: [
    SettingsController,
    EmailTemplateController,
  ],
  providers: [
    SystemSettingService,
    EmailTemplateService,
    EmailSenderService,
  ],
  exports: [
    SystemSettingService,
    EmailTemplateService,
    EmailSenderService,
  ],
})
export class SettingsModule implements OnModuleInit {
  constructor(private readonly emailTemplateService: EmailTemplateService) {}

  async onModuleInit(): Promise<void> {
    await this.emailTemplateService.seedDefaultTemplates();
  }
}
