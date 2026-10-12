export interface SavedFile {
  storageKey: string;
  url: string;
}

export interface SavedFileWithOriginal extends SavedFile {
  /** Key of the untouched original stored alongside the derivative that `storageKey`/`url` point to. */
  originalStorageKey: string;
}

export interface StorableFile {
  buffer: Buffer;
  mimeType: string;
}

export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');

export interface MediaStorageDriver {
  save(buffer: Buffer, originalFilename: string, mimeType: string): Promise<SavedFile>;
  /**
   * Stores an original and its public derivative under one shared id.
   * `storageKey`/`url` in the result identify the derivative; the original
   * is kept byte-for-byte. Either both files are written or neither is.
   */
  saveWithOriginal(
    original: StorableFile,
    derivative: StorableFile,
  ): Promise<SavedFileWithOriginal>;
  /**
   * Removes the file for `storageKey`, plus the original stored next to it
   * when `storageKey` is a derivative written by `saveWithOriginal`.
   */
  delete(storageKey: string): Promise<void>;
}
