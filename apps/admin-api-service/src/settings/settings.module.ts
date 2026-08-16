import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmailTemplateController } from './controllers/email-template.controller';
import { IpAccessController } from './controllers/ip-access.controller';
import { TenantConfigurationController } from './controllers/tenant-configuration.controller';
import { EmailTemplate, IpAccessRule } from './entities';
import { TenantConfigurationService, EmailTemplateService, IpAccessService } from './services';

@Module({
  imports: [TypeOrmModule.forFeature([EmailTemplate, IpAccessRule])],
  controllers: [TenantConfigurationController, EmailTemplateController, IpAccessController],
  providers: [TenantConfigurationService, EmailTemplateService, IpAccessService],
  exports: [TenantConfigurationService, EmailTemplateService, IpAccessService],
})
export class SettingsModule implements OnModuleInit {
  constructor(private readonly emailTemplateService: EmailTemplateService) {}

  async onModuleInit(): Promise<void> {
    await this.emailTemplateService.seedDefaultTemplates();
  }
}
