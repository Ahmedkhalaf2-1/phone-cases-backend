export interface SavedFile {
  storageKey: string;
  url: string;
}

export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');

export interface MediaStorageDriver {
  save(buffer: Buffer, originalFilename: string, mimeType: string): Promise<SavedFile>;
  delete(storageKey: string): Promise<void>;
}
