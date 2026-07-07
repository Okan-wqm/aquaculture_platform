/**
 * GraphQL output for the FD-0001 Altinn export (RPT-001). The operator
 * downloads the CSV or prints the block, transcribes it into the Altinn
 * FD-0001 form, then confirms the submission with the Altinn receipt.
 */
import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class BiomassAltinnExportOutput {
  @Field({ description: 'Suggested download filename for the CSV' })
  filename: string;

  @Field({ description: 'Reporting period label (yyyy-mm)' })
  periodLabel: string;

  @Field({ description: 'Form-ordered CSV (Section,Field,Value)' })
  csv: string;

  @Field({ description: 'Printable, section-ordered transcription block' })
  printable: string;

  @Field({ description: 'When this export was generated' })
  generatedAt: Date;
}
