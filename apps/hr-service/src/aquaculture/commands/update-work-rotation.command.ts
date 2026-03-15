import { UpdateWorkRotationInput } from '../dto/update-work-rotation.input';

export class UpdateWorkRotationCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: UpdateWorkRotationInput,
    public readonly userId: string,
  ) {}
}
