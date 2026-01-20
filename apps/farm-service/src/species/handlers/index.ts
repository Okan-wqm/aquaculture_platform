/**
 * Species Module Handlers
 * @module Species/Handlers
 */
export * from './create-species.handler';
export * from './update-species.handler';
export * from './delete-species.handler';
export * from './get-species.handler';
export * from './list-species.handler';
export * from './get-species-by-code.handler';

// Export all handlers for module registration
import { CreateSpeciesHandler } from './create-species.handler';
import { UpdateSpeciesHandler } from './update-species.handler';
import { DeleteSpeciesHandler } from './delete-species.handler';
import { GetSpeciesHandler } from './get-species.handler';
import { ListSpeciesHandler } from './list-species.handler';
import { GetSpeciesByCodeHandler } from './get-species-by-code.handler';

export const SpeciesCommandHandlers = [
  CreateSpeciesHandler,
  UpdateSpeciesHandler,
  DeleteSpeciesHandler,
];

export const SpeciesQueryHandlers = [
  GetSpeciesHandler,
  ListSpeciesHandler,
  GetSpeciesByCodeHandler,
];

export const SpeciesHandlers = [
  ...SpeciesCommandHandlers,
  ...SpeciesQueryHandlers,
];
