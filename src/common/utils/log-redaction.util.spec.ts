import { redactSensitiveUrl } from './log-redaction.util';

describe('redactSensitiveUrl', () => {
  it('redacts a guest order tracking token from the path', () => {
    const url = '/api/v1/orders/track/KeIyTuh2xnNP4Ivmwd0uqCuFG18Hv08DqdqZ2zJMnPQ';
    expect(redactSensitiveUrl(url)).toBe('/api/v1/orders/track/[REDACTED]');
  });

  it('redacts the token even with a trailing query string', () => {
    const url = '/api/v1/orders/track/abc123XYZ-_?locale=ar';
    expect(redactSensitiveUrl(url)).toBe('/api/v1/orders/track/[REDACTED]?locale=ar');
  });

  it('is case-insensitive on the route segment', () => {
    const url = '/API/V1/Orders/Track/some-token';
    expect(redactSensitiveUrl(url)).toBe('/API/V1/Orders/Track/[REDACTED]');
  });

  it('leaves unrelated URLs completely unchanged', () => {
    const url = '/api/v1/admin/orders/3230c6bc-8c0c-4d34-b7e6-1ba3b791e7ae';
    expect(redactSensitiveUrl(url)).toBe(url);
  });

  it('leaves a URL with no path parameter at all unchanged', () => {
    const url = '/api/v1/health';
    expect(redactSensitiveUrl(url)).toBe(url);
  });
});
