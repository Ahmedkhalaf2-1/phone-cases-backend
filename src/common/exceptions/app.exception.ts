import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Base class for domain errors that need a stable, machine-readable `code`
 * in addition to the HTTP status - so API consumers can branch on the code
 * instead of parsing human-readable messages.
 */
export class AppException extends HttpException {
  public readonly code: string;

  constructor(code: string, message: string, status: HttpStatus, details?: unknown) {
    super({ code, message, details }, status);
    this.code = code;
  }
}

export class ResourceNotFoundException extends AppException {
  constructor(resource: string, identifier: string) {
    super(
      `${resource.toUpperCase()}_NOT_FOUND`,
      `${resource} with identifier "${identifier}" was not found`,
      HttpStatus.NOT_FOUND,
    );
  }
}

export class DuplicateResourceException extends AppException {
  constructor(code: string, message: string) {
    super(code, message, HttpStatus.CONFLICT);
  }
}

export class InvalidStateTransitionException extends AppException {
  constructor(message: string) {
    super('INVALID_STATE_TRANSITION', message, HttpStatus.CONFLICT);
  }
}

export class InsufficientStockException extends AppException {
  constructor(stockItemId: string, requestedQuantity: number) {
    super(
      'INSUFFICIENT_STOCK',
      `Not enough available stock for stock item "${stockItemId}" to reserve ${requestedQuantity} unit(s)`,
      HttpStatus.CONFLICT,
    );
  }
}
