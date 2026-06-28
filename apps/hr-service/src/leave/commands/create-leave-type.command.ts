import { CreateLeaveTypeInput } from '../dto/create-leave-type.input';

export class CreateLeaveTypeCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly input: CreateLeaveTypeInput,
  ) {}
}
