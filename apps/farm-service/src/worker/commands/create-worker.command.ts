import { CreateWorkerInput } from '../dto/create-worker.input';

export class CreateWorkerCommand {
  constructor(
    public readonly input: CreateWorkerInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
