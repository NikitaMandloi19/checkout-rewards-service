import { StoreService } from '../src/store.service';

describe('Checkout and rewards invariants', () => {
  let store: StoreService;
  beforeEach(() => { store = new StoreService(); });

  async function buyOne(key: string, productId = 1, quantity = 1) {
    const cart: any = await store.createCart();
    await store.addItem(cart.id, productId, quantity);
    return store.checkout(cart.id, key);
  }

  it('does not create a duplicate order or deduct stock on idempotent retry', async () => {
    const cart: any = await store.createCart(); await store.addItem(cart.id, 1, 2);
    const before = store.products.get(1)!.inventory;
    const first: any = await store.checkout(cart.id, 'same-key');
    const retry: any = await store.checkout(cart.id, 'same-key');
    expect(first.id).toBe(retry.id); expect(retry.replayed).toBe(true);
    expect(store.products.get(1)!.inventory).toBe(before - 2);
    expect(store.report().totalSuccessfullyPlacedOrders).toBe(1);
  });

  it('serializes competing checkouts so limited stock cannot be oversold', async () => {
    const a: any = await store.createCart(); const b: any = await store.createCart();
    await store.addItem(a.id, 5, 2); await store.addItem(b.id, 5, 1);
    const results = await Promise.allSettled([store.checkout(a.id, 'limited-a'), store.checkout(b.id, 'limited-b')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(store.products.get(5)!.inventory).toBe(0);
    expect(store.report().totalSuccessfullyPlacedOrders).toBe(1);
  });

  it('generates one coupon per eligible milestone and permits only one redemption', async () => {
    for (let i = 0; i < 5; i++) await buyOne(`order-${i}`);
    const coupon: any = await store.generateCoupon(); expect(coupon.code).toBe('REWARD5');
    await expect(store.generateCoupon()).rejects.toMatchObject({ code: 'COUPON_ALREADY_GENERATED' });
    const a: any = await store.createCart(); const b: any = await store.createCart();
    await store.addItem(a.id, 2, 1); await store.addItem(b.id, 2, 1);
    const results = await Promise.allSettled([store.checkout(a.id, 'coupon-a', coupon.code), store.checkout(b.id, 'coupon-b', coupon.code)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(store.report().coupons).toEqual({ generated: 1, available: 0, redeemed: 1 });
  });

  it('does not consume a coupon when checkout fails due to inventory', async () => {
    for (let i = 0; i < 5; i++) await buyOne(`milestone-${i}`);
    const coupon: any = await store.generateCoupon();
    const cart: any = await store.createCart(); await store.addItem(cart.id, 5, 3);
    await expect(store.checkout(cart.id, 'fails-first', coupon.code)).rejects.toMatchObject({ code: 'INSUFFICIENT_INVENTORY' });
    expect(store.report().coupons.available).toBe(1);
  });

  it('uses integer cents and report reads do not mutate state', async () => {
    await buyOne('money-key', 1, 3);
    const first = store.report(); const second = store.report();
    expect(first.grossRevenue).toBe('38.97'); expect(second).toEqual(first);
  });
});
