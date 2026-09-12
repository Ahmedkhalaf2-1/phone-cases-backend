import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';

function fakeContext(originalUrl: string): ExecutionContext {
  const request = { method: 'GET', originalUrl, headers: {}, body: {} };
  const response = { statusCode: 200 };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

describe('LoggingInterceptor', () => {
  const trackingToken = 'KeIyTuh2xnNP4Ivmwd0uqCuFG18Hv08DqdqZ2zJMnPQ';
  const url = `/api/v1/orders/track/${trackingToken}`;

  it('never writes the raw guest tracking token to the success log line', (done) => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const interceptor = new LoggingInterceptor();
    const handler: CallHandler = { handle: () => of({ some: 'response' }) };

    interceptor.intercept(fakeContext(url), handler).subscribe({
      complete: () => {
        expect(logSpy).toHaveBeenCalledTimes(1);
        const loggedLine = logSpy.mock.calls[0][0] as string;
        expect(loggedLine).not.toContain(trackingToken);
        expect(loggedLine).toContain('/orders/track/[REDACTED]');
        logSpy.mockRestore();
        done();
      },
    });
  });

  it('never writes the raw guest tracking token to the error log line', (done) => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const interceptor = new LoggingInterceptor();
    const handler: CallHandler = { handle: () => throwError(() => new Error('boom')) };

    interceptor.intercept(fakeContext(url), handler).subscribe({
      error: () => {
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const loggedLine = warnSpy.mock.calls[0][0] as string;
        expect(loggedLine).not.toContain(trackingToken);
        expect(loggedLine).toContain('/orders/track/[REDACTED]');
        warnSpy.mockRestore();
        done();
      },
    });
  });
});
