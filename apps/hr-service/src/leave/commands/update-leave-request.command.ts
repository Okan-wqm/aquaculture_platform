import { UpdateLeaveRequestInput } from '../dto/create-leave-request.input';

export class UpdateLeaveRequestCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly input: UpdateLeaveRequestInput,
  ) {}
}
