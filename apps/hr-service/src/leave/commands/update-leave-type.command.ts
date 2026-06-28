import { UpdateLeaveTypeInput } from '../dto/update-leave-type.input';

export class UpdateLeaveTypeCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly input: UpdateLeaveTypeInput,
  ) {}
}
