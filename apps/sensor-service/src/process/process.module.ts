import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EdgeDeviceModule } from '../edge-device/edge-device.module';

import { Process } from './entities/process.entity';
import { ScadaPackage } from './entities/scada-package.entity';
import { UnifiedTag } from './entities/unified-tag.entity';
import { ScadaDeployLog } from './entities/scada-deploy-log.entity';
import { ProcessResolver } from './resolvers/process.resolver';
import { UnifiedTagResolver } from './resolvers/unified-tag.resolver';
import { ProcessService } from './services/process.service';
import { ScadaPackageService } from './services/scada-package.service';
import { UnifiedTagService } from './services/unified-tag.service';
import { ScadaDeployLogService } from './services/scada-deploy-log.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Process, ScadaPackage, UnifiedTag, ScadaDeployLog]),
    forwardRef(() => EdgeDeviceModule),
  ],
  providers: [
    ProcessService,
    ScadaPackageService,
    UnifiedTagService,
    ScadaDeployLogService,
    ProcessResolver,
    UnifiedTagResolver,
  ],
  exports: [ProcessService, ScadaPackageService, UnifiedTagService, ScadaDeployLogService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ProcessModule {}
