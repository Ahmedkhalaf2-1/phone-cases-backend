import { buildPaginatedResult } from './paginated-result';

describe('buildPaginatedResult', () => {
  it('computes totalPages by rounding up', () => {
    const result = buildPaginatedResult(['a', 'b'], 42, 1, 20);
    expect(result.meta).toEqual({ page: 1, pageSize: 20, totalItems: 42, totalPages: 3 });
  });

  it('reports totalPages of 1 when there are zero items, never 0', () => {
    const result = buildPaginatedResult([], 0, 1, 20);
    expect(result.meta.totalPages).toBe(1);
  });

  it('reports an exact page count when items divide evenly', () => {
    const result = buildPaginatedResult([], 40, 1, 20);
    expect(result.meta.totalPages).toBe(2);
  });
});
