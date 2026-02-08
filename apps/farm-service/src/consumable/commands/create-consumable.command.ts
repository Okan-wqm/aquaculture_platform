import { CreateConsumableInput as CreateConsumableInputDto } from '../dto/create-consumable.input';

export class CreateConsumableCommand {
  constructor(
    public readonly input: CreateConsumableInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

export type CreateConsumableInput = CreateConsumableInputDto;
