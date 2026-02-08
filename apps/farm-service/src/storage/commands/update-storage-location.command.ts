import { UpdateStorageLocationInput } from '../dto/update-storage-location.input';

export class UpdateStorageLocationCommand {
  constructor(
    public readonly locationId: string,
    public readonly input: UpdateStorageLocationInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
