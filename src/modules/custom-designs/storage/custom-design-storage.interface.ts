/**
 * Mirrors ReceiptStorageDriver's shape (see
 * src/modules/payments/receipts/receipt-storage) - PRIVATE files with no
 * public URL. `save` returns only a generated storage key, never a
 * client-servable link; `read` is the only way to get bytes back out,
 * always through CustomDesignsService's own ownership/role checks, never a
 * static file route.
 */
export interface SavedCustomDesignFile {
  storageKey: string;
}

export const CUSTOM_DESIGN_STORAGE = Symbol('CUSTOM_DESIGN_STORAGE');

export interface CustomDesignStorageDriver {
  save(buffer: Buffer, mimeType: string): Promise<SavedCustomDesignFile>;
  read(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
}
