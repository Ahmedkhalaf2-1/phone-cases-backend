import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { MulterError } from 'multer';
import { AppException } from '../exceptions/app.exception';
import { redactSensitiveUrl } from '../utils/log-redaction.util';

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

const STATUS_CODE_MAP: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
  // NestJS's FileInterceptor already converts a MulterError with code
  // LIMIT_FILE_SIZE into its own PayloadTooLargeException before this
  // filter ever sees it - the MulterError branch above is a defensive
  // fallback for any future multer usage that bypasses FileInterceptor.
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'FILE_TOO_LARGE',
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId = (request.headers['x-request-id'] as string | undefined) ?? undefined;

    const { status, body } = this.resolve(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${redactSensitiveUrl(request.url)} -> ${status} [${correlationId ?? 'no-correlation-id'}]`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    // `path` here echoes the request back to the same caller who sent it
    // (a normal REST error-body convention) - it is not a log, so it is
    // not redacted; only the two `logger.*` lines above (which persist
    // into server-side logs a third party could read) are.
    response.status(status).json({
      statusCode: status,
      correlationId,
      timestamp: new Date().toISOString(),
      path: request.url,
      ...body,
    });
  }

  private resolve(exception: unknown): { status: HttpStatus; body: ErrorBody } {
    // Multer throws a plain Error subclass (never an HttpException) when a
    // file upload violates its configured limits (e.g. FileInterceptor's
    // `limits.fileSize` on the receipt/media upload routes) - without this,
    // a client sending an oversized file would see an opaque 500 instead
    // of a clear 400.
    if (exception instanceof MulterError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          code: exception.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR',
          message: exception.message,
        },
      };
    }

    if (exception instanceof AppException) {
      const status: HttpStatus = exception.getStatus();
      const payload = exception.getResponse() as ErrorBody;
      return {
        status,
        body: { code: payload.code, message: payload.message, details: payload.details },
      };
    }

    if (exception instanceof HttpException) {
      const status: HttpStatus = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'object' && payload !== null) {
        const payloadObj = payload as Record<string, unknown>;
        const rawMessage = payloadObj.message ?? exception.message;
        const message = Array.isArray(rawMessage)
          ? rawMessage.map((entry) => this.stringifyMessagePart(entry)).join('; ')
          : this.stringifyMessagePart(rawMessage);
        return {
          status,
          body: {
            code: STATUS_CODE_MAP[status] ?? 'HTTP_ERROR',
            message,
            details: Array.isArray(rawMessage) ? rawMessage : undefined,
          },
        };
      }
      return {
        status,
        body: {
          code: STATUS_CODE_MAP[status] ?? 'HTTP_ERROR',
          message: this.stringifyMessagePart(payload),
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    };
  }

  private stringifyMessagePart(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
}
