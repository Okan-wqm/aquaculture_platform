import { UpdateCertificationTypeInput } from '../dto/update-certification-type.input';

export class UpdateCertificationTypeCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly input: UpdateCertificationTypeInput,
  ) {}
}
