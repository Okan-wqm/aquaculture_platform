import { UpdateWorkerInput } from '../dto/update-worker.input';

export class UpdateWorkerCommand {
  constructor(
    public readonly input: UpdateWorkerInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
