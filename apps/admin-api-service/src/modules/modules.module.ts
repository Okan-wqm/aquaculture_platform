import { Module } from '@nestjs/common';

import { AuthCommandClientModule } from '../auth/auth-command-client.module';

import { ModulesController } from './modules.controller';
import { ModulesService } from './modules.service';

@Module({
  imports: [AuthCommandClientModule],
  controllers: [ModulesController],
  providers: [ModulesService],
  exports: [ModulesService],
})
export class SystemModulesModule {}
