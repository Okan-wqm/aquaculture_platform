import { CreateCertificationTypeInput } from '../dto/create-certification-type.input';

export class CreateCertificationTypeCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly input: CreateCertificationTypeInput,
  ) {}
}
