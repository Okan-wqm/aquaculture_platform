/**
 * Add Chemical Document Handler
 * Adds a document reference to a chemical's documents JSONB array
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, Logger, ConflictException } from '@nestjs/common';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { AddDocumentCommand } from '../commands/add-document.command';
import { Chemical, ChemicalDocument } from '../entities/chemical.entity';

@CommandHandler(AddDocumentCommand)
export class AddDocumentHandler implements ICommandHandler<AddDocumentCommand, Chemical> {
  private readonly logger = new Logger(AddDocumentHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: AddDocumentCommand): Promise<Chemical> {
    const { chemicalId, input, tenantId, userId } = command;

    this.logger.log(`Adding document to chemical ${chemicalId} for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const chemicalRepo = tenantManagerRepo(queryRunner.manager, Chemical, tenantId);

      // Find existing chemical with tenant isolation
      const chemical = await chemicalRepo.findOne({
        where: { id: chemicalId, tenantId, isDeleted: false },
      });

      if (!chemical) {
        throw new NotFoundException(`Chemical with ID "${chemicalId}" not found`);
      }

      // Initialize documents array if null
      const documents: ChemicalDocument[] = chemical.documents || [];

      // Check if document with same ID already exists
      const existingDoc = documents.find(doc => doc.id === input.documentId);
      if (existingDoc) {
        throw new ConflictException(`Document with ID "${input.documentId}" already exists for this chemical`);
      }

      // Create new document entry
      const newDocument: ChemicalDocument = {
        id: input.documentId,
        name: input.documentName,
        type: input.documentType,
        url: input.url,
        uploadedAt: input.uploadedAt,
        uploadedBy: input.uploadedBy,
      };

      // Add to documents array
      documents.push(newDocument);

      // Update chemical
      chemical.documents = documents;
      chemical.updatedBy = userId;

      const updatedChemical = await chemicalRepo.save(chemical);

      this.logger.log(`Document ${input.documentId} added to chemical ${chemicalId} successfully`);

      return updatedChemical;
    });
  }
}
