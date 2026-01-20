/**
 * System Handlers Export
 */
export * from './create-system.handler';
export * from './update-system.handler';
export * from './delete-system.handler';
export * from './get-system.handler';
export * from './list-systems.handler';
export * from './get-system-delete-preview.handler';

import { CreateSystemHandler } from './create-system.handler';
import { UpdateSystemHandler } from './update-system.handler';
import { DeleteSystemHandler } from './delete-system.handler';
import { GetSystemHandler } from './get-system.handler';
import { ListSystemsHandler } from './list-systems.handler';
import { GetSystemDeletePreviewHandler } from './get-system-delete-preview.handler';

export const SystemCommandHandlers = [
  CreateSystemHandler,
  UpdateSystemHandler,
  DeleteSystemHandler,
];

export const SystemQueryHandlers = [
  GetSystemHandler,
  ListSystemsHandler,
  GetSystemDeletePreviewHandler,
];

export const SystemHandlers = [
  ...SystemCommandHandlers,
  ...SystemQueryHandlers,
];
