import { CreateStorageLocationInput } from '../dto/create-storage-location.input';

export class CreateStorageLocationCommand {
  constructor(
    public readonly input: CreateStorageLocationInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
