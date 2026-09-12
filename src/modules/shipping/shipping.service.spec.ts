import { computeShippingPrice } from './shipping.service';

describe('computeShippingPrice', () => {
  it('returns the rate price when below the free-shipping threshold', () => {
    expect(computeShippingPrice({ price: 5000, freeShippingThreshold: 100000 }, 50000)).toBe(5000);
  });

  it('returns 0 once the basis amount reaches the threshold', () => {
    expect(computeShippingPrice({ price: 5000, freeShippingThreshold: 100000 }, 100000)).toBe(0);
  });

  it('returns 0 once the basis amount exceeds the threshold', () => {
    expect(computeShippingPrice({ price: 5000, freeShippingThreshold: 100000 }, 150000)).toBe(0);
  });

  it('always returns the rate price when there is no threshold', () => {
    expect(computeShippingPrice({ price: 5000, freeShippingThreshold: null }, 999999)).toBe(5000);
  });
});
