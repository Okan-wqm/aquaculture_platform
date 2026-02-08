import { UpdateConsumableInput as UpdateConsumableInputDto } from '../dto/update-consumable.input';

export class UpdateConsumableCommand {
  constructor(
    public readonly consumableId: string,
    public readonly input: UpdateConsumableInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

export type UpdateConsumableInput = UpdateConsumableInputDto;
