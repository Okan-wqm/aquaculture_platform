import { Module } from '@nestjs/common';

import { SettingsModule } from '../settings/settings.module';

import { PasswordResetController } from './password-reset.controller';

@Module({
  imports: [SettingsModule],
  controllers: [PasswordResetController],
})
export class PasswordResetModule {}
