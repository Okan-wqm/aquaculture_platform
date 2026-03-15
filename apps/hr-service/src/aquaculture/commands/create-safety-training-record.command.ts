import { CreateSafetyTrainingRecordInput } from '../dto/create-safety-training-record.input';

export class CreateSafetyTrainingRecordCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: CreateSafetyTrainingRecordInput,
    public readonly userId: string,
  ) {}
}
