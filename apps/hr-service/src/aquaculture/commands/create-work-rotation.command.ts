import { CreateWorkRotationInput } from '../dto/create-work-rotation.input';

export class CreateWorkRotationCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: CreateWorkRotationInput,
    public readonly userId: string,
  ) {}
}
