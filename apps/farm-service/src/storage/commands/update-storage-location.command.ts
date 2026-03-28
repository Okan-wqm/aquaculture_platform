import { UpdateStorageLocationInput } from '../dto/update-storage-location.input';

/**
 * The update payload without the `id` field, which is passed separately as
 * `locationId`. This avoids an `as any` cast in the resolver when spreading
 * `{ id, ...updateData }` from the GraphQL input.
 */
export type UpdateStorageLocationData = Omit<UpdateStorageLocationInput, 'id'>;

export class UpdateStorageLocationCommand {
  constructor(
    public readonly locationId: string,
    public readonly input: UpdateStorageLocationData,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
