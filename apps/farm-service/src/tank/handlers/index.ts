/**
 * Tank Module Handlers
 * @module Tank/Handlers
 */
export * from './create-tank.handler';
export * from './update-tank.handler';
export * from './update-tank-status.handler';
export * from './delete-tank.handler';
export * from './get-tank.handler';
export * from './list-tanks.handler';
export * from './get-tank-batches.handler';
export * from './get-tank-operations.handler';
export * from './get-tank-capacity.handler';

// Export all handlers for module registration
import { CreateTankHandler } from './create-tank.handler';
import { UpdateTankHandler } from './update-tank.handler';
import { UpdateTankStatusHandler } from './update-tank-status.handler';
import { DeleteTankHandler } from './delete-tank.handler';
import { GetTankHandler } from './get-tank.handler';
import { ListTanksHandler } from './list-tanks.handler';
import { GetTankBatchesHandler } from './get-tank-batches.handler';
import { GetTankOperationsHandler } from './get-tank-operations.handler';
import { GetTankCapacityHandler } from './get-tank-capacity.handler';

export const TankCommandHandlers = [
  CreateTankHandler,
  UpdateTankHandler,
  UpdateTankStatusHandler,
  DeleteTankHandler,
];

export const TankQueryHandlers = [
  GetTankHandler,
  ListTanksHandler,
  GetTankBatchesHandler,
  GetTankOperationsHandler,
  GetTankCapacityHandler,
];

export const TankHandlers = [
  ...TankCommandHandlers,
  ...TankQueryHandlers,
];
