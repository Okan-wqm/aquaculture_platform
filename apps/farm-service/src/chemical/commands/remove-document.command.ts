/**
 * Remove Chemical Document Command
 * Removes a document reference from a chemical's documents array
 */
export class RemoveDocumentCommand {
  constructor(
    public readonly chemicalId: string,
    public readonly documentId: string,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
