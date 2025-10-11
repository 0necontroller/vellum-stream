import mime from "mime-types";
import { ENV } from "./environments";

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
}

/**
 * Convert size string (e.g., "100mb", "1gb") to bytes
 */
export function parseSize(sizeStr: string): number {
  const size = sizeStr.toLowerCase().trim();
  const match = size.match(/^(\d+(?:\.\d+)?)(b|kb|mb|gb|tb)?$/);

  if (!match) {
    throw new Error(`Invalid size format: ${sizeStr}`);
  }

  const value = parseFloat(match[1]);
  const unit = match[2] || "b";

  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024,
  };

  return Math.floor(value * multipliers[unit]);
}

/**
 * Validate file size against the configured maximum
 */
export function validateFileSize(filesize: number): ValidationResult {
  const errors: ValidationError[] = [];

  if (typeof filesize !== "number" || filesize <= 0) {
    errors.push({
      field: "filesize",
      message: "File size must be a positive number (bytes)",
    });
    return { isValid: false, errors };
  }

  const maxSize = parseSize(ENV.MAX_FILE_SIZE);

  if (filesize > maxSize) {
    const maxSizeMB = Math.round(maxSize / (1024 * 1024));
    const fileSizeMB = Math.round(filesize / (1024 * 1024));
    errors.push({
      field: "filesize",
      message: `File size (${fileSizeMB}MB) exceeds maximum allowed size (${maxSizeMB}MB)`,
    });
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Normalize MIME types to match expected video formats
 * Some libraries return different MIME types than what we expect
 */
function normalizeMimeType(mimeType: string): string {
  const mimeTypeMap: Record<string, string> = {
    "application/mp4": "video/mp4",
    // video/webm, video/quicktime, and video/x-matroska are already returned correctly by mime.lookup()
  };

  return mimeTypeMap[mimeType] || mimeType;
}

/**
 * Validate file type against the configured allowed types
 */
export function validateFileType(filename: string): ValidationResult {
  const errors: ValidationError[] = [];

  if (!filename || typeof filename !== "string") {
    errors.push({
      field: "filename",
      message: "Filename is required and must be a string",
    });
    return { isValid: false, errors };
  }

  // Get MIME type from filename
  const rawMimeType = mime.lookup(filename);

  if (!rawMimeType) {
    errors.push({
      field: "filename",
      message: "Could not determine file type from filename",
    });
    return { isValid: false, errors };
  }

  // Normalize the MIME type to match our expected format
  const mimeType = normalizeMimeType(rawMimeType);

  // Check if the MIME type is in the allowed list
  if (!ENV.ALLOWED_FILE_TYPES.includes(mimeType)) {
    errors.push({
      field: "filename",
      message: `File type '${mimeType}' is not allowed. Allowed types: ${ENV.ALLOWED_FILE_TYPES.join(
        ", "
      )}`,
    });
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Perform all upload validations
 */
export function validateUpload(
  filename: string,
  filesize: number
): ValidationResult {
  const allErrors: ValidationError[] = [];

  // Validate file type
  const fileTypeResult = validateFileType(filename);
  if (!fileTypeResult.isValid) {
    allErrors.push(...fileTypeResult.errors);
  }

  // Validate file size
  const fileSizeResult = validateFileSize(filesize);
  if (!fileSizeResult.isValid) {
    allErrors.push(...fileSizeResult.errors);
  }

  return { isValid: allErrors.length === 0, errors: allErrors };
}

/**
 * Format validation errors for API response
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  if (errors.length === 1) {
    return errors[0].message;
  }

  return `Multiple validation errors: ${errors
    .map((e) => e.message)
    .join("; ")}`;
}
