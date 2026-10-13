// Decimal MB: 512 MiB would exceed the requested ChatGPT attachment ceiling.
export const EXPORT_MAX_FILE_BYTES = 512_000_000;
export const EXPORT_CHUNK_BYTES = 512 * 1024;
export const EXPORT_BUFFER_BYTES = 2 * EXPORT_MAX_FILE_BYTES;
export const EXPORT_TTL_SECONDS = 3600;
