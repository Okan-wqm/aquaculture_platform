import { ICommand } from '@platform/cqrs';

/**
 * Location input interface
 */
export interface LocationInput {
  lat: number;
  lng: number;
}

/**
 * Create Farm Command
 * Command to create a new farm in the system
 */
export class CreateFarmCommand implements ICommand {
  readonly commandName = 'CreateFarm';

  constructor(
    public readonly name: string,
    public readonly location: LocationInput,
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly address?: string,
    public readonly contactPerson?: string,
    public readonly contactPhone?: string,
    public readonly contactEmail?: string,
    public readonly description?: string,
    public readonly totalArea?: number,
  ) {}
}
