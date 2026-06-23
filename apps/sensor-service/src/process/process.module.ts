import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AutomationModule } from '../automation/automation.module';
import { AutomationProgram } from '../automation/entities/automation-program.entity';
import { ProgramVariable } from '../automation/entities/program-variable.entity';
import { EdgeDeviceModule } from '../edge-device/edge-device.module';
import { DeviceIoConfig } from '../edge-device/entities/device-io-config.entity';
import { EdgeDevice } from '../edge-device/entities/edge-device.entity';

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
    TypeOrmModule.forFeature([
      Process, ScadaPackage, UnifiedTag, ScadaDeployLog,
      DeviceIoConfig, EdgeDevice,
      AutomationProgram, ProgramVariable,
    ]),
    forwardRef(() => EdgeDeviceModule),
    forwardRef(() => AutomationModule), // For AutomationService in unified deploy
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
 
export class ProcessModule {}
