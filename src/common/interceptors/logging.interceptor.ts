import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

const REDACTED_KEYS = new Set([
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cardnumber',
  'cvv',
  'addressline1',
  'addressline2',
  'phone',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redact(val, depth + 1);
  }
  return result;
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const start = Date.now();
    const correlationId = (request.headers['x-request-id'] as string | undefined) ?? '-';

    return next.handle().pipe(
      tap({
        next: () => {
          const durationMs = Date.now() - start;
          this.logger.log(
            `${request.method} ${request.originalUrl} ${response.statusCode} ${durationMs}ms [${correlationId}]`,
          );
        },
        error: () => {
          const durationMs = Date.now() - start;
          this.logger.warn(
            `${request.method} ${request.originalUrl} ${response.statusCode} ${durationMs}ms [${correlationId}] body=${JSON.stringify(
              redact(request.body),
            )}`,
          );
        },
      }),
    );
  }
}
