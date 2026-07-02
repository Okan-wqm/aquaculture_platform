/**
 * Remove Chemical Document Handler
 * Removes a document reference from a chemical's documents JSONB array
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, Logger } from '@nestjs/common';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { RemoveDocumentCommand } from '../commands/remove-document.command';
import { Chemical, ChemicalDocument } from '../entities/chemical.entity';

@CommandHandler(RemoveDocumentCommand)
export class RemoveDocumentHandler implements ICommandHandler<RemoveDocumentCommand, boolean> {
  private readonly logger = new Logger(RemoveDocumentHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: RemoveDocumentCommand): Promise<boolean> {
    const { chemicalId, documentId, tenantId, userId } = command;

    this.logger.log(`Removing document ${documentId} from chemical ${chemicalId} for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const chemicalRepo = tenantManagerRepo(queryRunner.manager, Chemical, tenantId);

      // Find existing chemical with tenant isolation
      const chemical = await chemicalRepo.findOne({
        where: { id: chemicalId, tenantId, isDeleted: false },
      });

      if (!chemical) {
        throw new NotFoundException(`Chemical with ID "${chemicalId}" not found`);
      }

      // Get documents array
      const documents: ChemicalDocument[] = chemical.documents || [];

      // Find document index
      const documentIndex = documents.findIndex(doc => doc.id === documentId);

      if (documentIndex === -1) {
        throw new NotFoundException(`Document with ID "${documentId}" not found in chemical`);
      }

      // Remove document from array
      documents.splice(documentIndex, 1);

      // Update chemical
      chemical.documents = documents.length > 0 ? documents : undefined;
      chemical.updatedBy = userId;

      await chemicalRepo.save(chemical);

      this.logger.log(`Document ${documentId} removed from chemical ${chemicalId} successfully`);

      return true;
    });
  }
}
