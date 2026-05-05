export interface StorageObjectMetadata {
  contentLength: number;
  contentType: string;
}

export interface StorageObjectVerifier {
  verifyObject(storageKey: string): Promise<StorageObjectMetadata>;
}

export const STORAGE_OBJECT_VERIFIER = Symbol('STORAGE_OBJECT_VERIFIER');
