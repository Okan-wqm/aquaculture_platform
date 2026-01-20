/**
 * Add Chemical Document Command
 * Adds a document reference to a chemical's documents array
 */
export interface AddDocumentInput {
  documentId: string;
  documentName: string;
  documentType: 'msds' | 'label' | 'protocol' | 'certificate' | 'other';
  url: string;
  uploadedAt: string;
  uploadedBy: string;
}

export class AddDocumentCommand {
  constructor(
    public readonly chemicalId: string,
    public readonly input: AddDocumentInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
