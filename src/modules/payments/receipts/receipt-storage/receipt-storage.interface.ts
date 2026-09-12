/**
 * Mirrors MediaStorageDriver's shape (see
 * src/modules/catalog/media/storage/media-storage.interface.ts) but for
 * PRIVATE files with no public URL: `save` returns only a generated
 * storage key, never a client-servable link, and `read` is the only way
 * to get bytes back out - always through ReceiptsService's own
 * ownership/role checks, never a static file route.
 */
export interface SavedReceiptFile {
  storageKey: string;
}

export const RECEIPT_STORAGE = Symbol('RECEIPT_STORAGE');

export interface ReceiptStorageDriver {
  save(buffer: Buffer, mimeType: string): Promise<SavedReceiptFile>;
  read(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
}
