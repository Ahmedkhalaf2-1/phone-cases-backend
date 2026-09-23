import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, map } from 'rxjs';

// Locally-stored media URLs are persisted as absolute strings
// (`${APP_URL}/uploads/<key>`) at upload time - see LocalMediaStorageService.
// If APP_URL changes later (e.g. the dev machine's LAN IP changes), every
// previously-uploaded row still has the old host baked in. Rather than
// trusting the stored host, rewrite it to the *current* APP_URL on every
// response, matched narrowly on the "/uploads/" path so S3-driver URLs
// (which never contain that segment) pass through untouched.
const UPLOADS_URL_PATTERN = /^https?:\/\/[^/]+(\/uploads\/.+)$/;
const MAX_DEPTH = 8;

@Injectable()
export class MediaUrlRewriteInterceptor implements NestInterceptor {
  constructor(private readonly configService: ConfigService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(map((data) => rewrite(data, this.configService.getOrThrow<string>('APP_URL'), 0)));
  }
}

function rewrite(value: unknown, appUrl: string, depth: number): unknown {
  if (depth > MAX_DEPTH || value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    const match = UPLOADS_URL_PATTERN.exec(value);
    return match ? `${appUrl}${match[1]}` : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewrite(item, appUrl, depth + 1));
  }
  if (typeof value === 'object') {
    if (value instanceof Date || Buffer.isBuffer(value)) {
      return value;
    }
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = rewrite(val, appUrl, depth + 1);
    }
    return result;
  }
  return value;
}
