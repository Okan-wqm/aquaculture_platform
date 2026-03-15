import { UpdateWorkAreaInput } from '../dto/update-work-area.input';

export class UpdateWorkAreaCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: UpdateWorkAreaInput,
    public readonly userId: string,
  ) {}
}
