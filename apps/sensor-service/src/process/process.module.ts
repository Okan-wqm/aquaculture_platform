import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EdgeDeviceModule } from '../edge-device/edge-device.module';

import { Process } from './entities/process.entity';
import { ScadaPackage } from './entities/scada-package.entity';
import { ProcessResolver } from './resolvers/process.resolver';
import { ProcessService } from './services/process.service';
import { ScadaPackageService } from './services/scada-package.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Process, ScadaPackage]),
    forwardRef(() => EdgeDeviceModule),
  ],
  providers: [ProcessService, ScadaPackageService, ProcessResolver],
  exports: [ProcessService, ScadaPackageService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ProcessModule {}
