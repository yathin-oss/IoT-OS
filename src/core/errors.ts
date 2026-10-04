/**
 * Structured application error. Services throw IotosError so that the IPC layer can
 * transport code + message + details to the UI without losing meaning.
 */
export type ErrorCode =
  // project
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_MANIFEST_MISSING'
  | 'PROJECT_INVALID_JSON'
  | 'PROJECT_SCHEMA_INVALID'
  | 'PROJECT_VERSION_UNSUPPORTED'
  | 'PROJECT_EXISTS'
  | 'PROJECT_NOT_OPEN'
  // filesystem
  | 'FS_PATH_OUTSIDE_PROJECT'
  | 'FS_NOT_FOUND'
  | 'FS_EXISTS'
  | 'FS_IO'
  // hardware
  | 'BOARD_UNKNOWN'
  | 'COMPONENT_UNKNOWN'
  | 'HARDWARE_INVALID'
  // toolchain/build
  | 'TOOL_MISSING'
  | 'TOOL_FAILED'
  | 'TOOL_TIMEOUT'
  | 'TOOL_CANCELLED'
  | 'TOOL_NOT_ALLOWED'
  | 'CORE_MISSING'
  | 'LIBRARY_MISSING'
  | 'BUILD_BLOCKED'
  | 'BUILD_FAILED'
  | 'BUILD_UNSUPPORTED'
  // device/flash/serial
  | 'DEVICE_NOT_FOUND'
  | 'DEVICE_BUSY'
  | 'FLASH_BLOCKED'
  | 'FLASH_NEEDS_CONFIRMATION'
  | 'FLASH_FAILED'
  | 'FLASH_UNSUPPORTED'
  | 'ARTIFACT_MISSING'
  | 'SERIAL_OPEN_FAILED'
  | 'SERIAL_NOT_OPEN'
  | 'SERIAL_WRITE_FAILED'
  // ai
  | 'AI_NOT_CONFIGURED'
  | 'AI_PROVIDER_ERROR'
  | 'AI_MALFORMED_RESPONSE'
  | 'AI_INVALID_PROPOSAL'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_CONFLICT'
  // generic
  | 'INVALID_ARGUMENT'
  | 'UNKNOWN_METHOD'
  | 'INTERNAL';

export class IotosError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, opts?: { details?: Record<string, unknown>; hint?: string; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'IotosError';
    this.code = code;
    this.details = opts?.details;
    this.hint = opts?.hint;
  }

  toJSON(): SerializedError {
    return { code: this.code, message: this.message, details: this.details, hint: this.hint };
  }
}

export interface SerializedError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown> | undefined;
  hint?: string | undefined;
}

export function toSerializedError(err: unknown): SerializedError {
  if (err instanceof IotosError) return err.toJSON();
  if (err instanceof Error) return { code: 'INTERNAL', message: err.message };
  return { code: 'INTERNAL', message: String(err) };
}

export function isIotosError(err: unknown, code?: ErrorCode): err is IotosError {
  return err instanceof IotosError && (code === undefined || err.code === code);
}
