import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException } from '../exceptions/app.exception';

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
        `${request.method} ${request.url} -> ${status} [${correlationId ?? 'no-correlation-id'}]`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(status).json({
      statusCode: status,
      correlationId,
      timestamp: new Date().toISOString(),
      path: request.url,
      ...body,
    });
  }

  private resolve(exception: unknown): { status: HttpStatus; body: ErrorBody } {
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
