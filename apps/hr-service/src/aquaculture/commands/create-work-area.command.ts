import { CreateWorkAreaInput } from '../dto/create-work-area.input';

export class CreateWorkAreaCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: CreateWorkAreaInput,
    public readonly userId: string,
  ) {}
}
