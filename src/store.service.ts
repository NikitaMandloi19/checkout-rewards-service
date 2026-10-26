import { Injectable } from '@nestjs/common';

export type Product = { id: number; name: string; priceCents: number; inventory: number };
export type CartItem = { productId: number; quantity: number };
export type Cart = { id: string; items: CartItem[]; checkedOutOrderId?: string };
export type OrderLine = { productId: number; productName: string; unitPriceCents: number; quantity: number; lineTotalCents: number };
export type Order = { id: string; cartId: string; lines: OrderLine[]; subtotalCents: number; couponCode?: string; discountCents: number; totalCents: number; createdAt: string };
export type Coupon = { code: string; milestone: number; percent: number; status: 'AVAILABLE' | 'REDEEMED'; redeemedByOrderId?: string };

// A process-wide mutex makes mutations atomic for this single Node.js process.
// It is intentionally simple; see DECISIONS.md for the multi-instance/DB design.
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
}

@Injectable()
export class StoreService {
  private readonly mutex = new Mutex();
  readonly products = new Map<number, Product>([
    [1, { id: 1, name: 'Everyday Mug', priceCents: 1299, inventory: 30 }],
    [2, { id: 2, name: 'Canvas Tote', priceCents: 1899, inventory: 20 }],
    [3, { id: 3, name: 'Wireless Mouse', priceCents: 2499, inventory: 8 }],
    [4, { id: 4, name: 'Desk Lamp', priceCents: 3499, inventory: 12 }],
    [5, { id: 5, name: 'Limited Edition Keyboard', priceCents: 8999, inventory: 2 }],
  ]);
  private readonly carts = new Map<string, Cart>();
  private readonly orders = new Map<string, Order>();
  private readonly idempotency = new Map<string, string>();
  private readonly coupons = new Map<string, Coupon>();
  private readonly milestoneCoupons = new Map<number, string>();
  private nextCart = 1; private nextOrder = 1;
  readonly rewardEvery = 5; readonly rewardPercent = 10;

  listProducts() { return [...this.products.values()].map(p => ({ ...p, price: this.money(p.priceCents) })); }
  async createCart() { return this.mutex.run(() => { const cart: Cart = { id: `cart_${this.nextCart++}`, items: [] }; this.carts.set(cart.id, cart); return this.viewCart(cart); }); }
  getCart(id: string) { const cart = this.carts.get(id); if (!cart) throw this.err(404, 'CART_NOT_FOUND', `Cart ${id} was not found`); return this.viewCart(cart); }

  async addItem(cartId: string, productId: number, quantity: number) {
    return this.mutex.run(() => {
      const cart = this.requireOpenCart(cartId); this.validateProductQuantity(productId, quantity);
      const existing = cart.items.find(i => i.productId === productId);
      const newQty = (existing?.quantity ?? 0) + quantity;
      if (newQty > 100) throw this.err(400, 'QUANTITY_LIMIT', 'Maximum quantity per product in a cart is 100');
      if (existing) existing.quantity = newQty; else cart.items.push({ productId, quantity });
      return this.viewCart(cart);
    });
  }
  async updateItem(cartId: string, productId: number, quantity: number) {
    return this.mutex.run(() => {
      const cart = this.requireOpenCart(cartId); this.validateProductQuantity(productId, quantity);
      const item = cart.items.find(i => i.productId === productId); if (!item) throw this.err(404, 'CART_ITEM_NOT_FOUND', 'Product is not in this cart');
      item.quantity = quantity; return this.viewCart(cart);
    });
  }
  async removeItem(cartId: string, productId: number) {
    return this.mutex.run(() => {
      const cart = this.requireOpenCart(cartId); const index = cart.items.findIndex(i => i.productId === productId);
      if (index < 0) throw this.err(404, 'CART_ITEM_NOT_FOUND', 'Product is not in this cart');
      cart.items.splice(index, 1); return this.viewCart(cart);
    });
  }

  async checkout(cartId: string, idempotencyKey: string, couponCode?: string) {
    return this.mutex.run(() => {
      if (!idempotencyKey || idempotencyKey.length > 128) throw this.err(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key header (1-128 characters)');
      const previousOrderId = this.idempotency.get(idempotencyKey);
      if (previousOrderId) { const previous = this.orders.get(previousOrderId)!; if (previous.cartId !== cartId) throw this.err(409, 'IDEMPOTENCY_KEY_REUSED', 'This key belongs to a different cart'); return { ...previous, replayed: true }; }
      const cart = this.requireOpenCart(cartId);
      if (!cart.items.length) throw this.err(400, 'EMPTY_CART', 'Cannot check out an empty cart');
      const lines: OrderLine[] = [];
      for (const item of cart.items) {
        const product = this.products.get(item.productId);
        if (!product) throw this.err(404, 'PRODUCT_NOT_FOUND', `Product ${item.productId} no longer exists`);
        if (item.quantity > product.inventory) throw this.err(409, 'INSUFFICIENT_INVENTORY', `Only ${product.inventory} unit(s) of ${product.name} remain`, { productId: product.id, available: product.inventory });
        lines.push({ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: item.quantity, lineTotalCents: product.priceCents * item.quantity });
      }
      let coupon: Coupon | undefined;
      if (couponCode) { coupon = this.coupons.get(couponCode.toUpperCase()); if (!coupon) throw this.err(404, 'COUPON_NOT_FOUND', 'Coupon does not exist'); if (coupon.status !== 'AVAILABLE') throw this.err(409, 'COUPON_ALREADY_REDEEMED', 'Coupon has already been redeemed'); }
      const subtotalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
      // Integer-cent arithmetic; percentage discount rounds half-up to the nearest cent.
      const discountCents = coupon ? Math.min(subtotalCents, Math.floor((subtotalCents * coupon.percent + 50) / 100)) : 0;
      const order: Order = { id: `order_${this.nextOrder++}`, cartId, lines, subtotalCents, couponCode: coupon?.code, discountCents, totalCents: Math.max(0, subtotalCents - discountCents), createdAt: new Date().toISOString() };
      // All validation happens before mutation; in this critical section these changes commit together.
      for (const line of lines) this.products.get(line.productId)!.inventory -= line.quantity;
      if (coupon) { coupon.status = 'REDEEMED'; coupon.redeemedByOrderId = order.id; }
      this.orders.set(order.id, order); this.idempotency.set(idempotencyKey, order.id); cart.checkedOutOrderId = order.id;
      return { ...order, replayed: false };
    });
  }

  getOrder(id: string) { const order = this.orders.get(id); if (!order) throw this.err(404, 'ORDER_NOT_FOUND', `Order ${id} was not found`); return this.withMoney(order); }
  async generateCoupon() {
    return this.mutex.run(() => {
      const completedOrders = this.orders.size; const eligibleMilestone = Math.floor(completedOrders / this.rewardEvery) * this.rewardEvery;
      if (eligibleMilestone < this.rewardEvery) throw this.err(409, 'MILESTONE_NOT_REACHED', `A coupon becomes eligible after ${this.rewardEvery} successful orders`, { successfulOrders: completedOrders, nextMilestone: this.rewardEvery });
      if (this.milestoneCoupons.has(eligibleMilestone)) throw this.err(409, 'COUPON_ALREADY_GENERATED', `Coupon for milestone ${eligibleMilestone} was already generated`);
      const code = `REWARD${eligibleMilestone}`; const coupon: Coupon = { code, milestone: eligibleMilestone, percent: this.rewardPercent, status: 'AVAILABLE' };
      this.coupons.set(code, coupon); this.milestoneCoupons.set(eligibleMilestone, code); return { ...coupon };
    });
  }
  report() {
    const purchased: Record<string, { productId: number; productName: string; quantity: number }> = {};
    let gross = 0, discounts = 0;
    for (const order of this.orders.values()) { gross += order.subtotalCents; discounts += order.discountCents; for (const line of order.lines) { const key = String(line.productId); purchased[key] ??= { productId: line.productId, productName: line.productName, quantity: 0 }; purchased[key].quantity += line.quantity; } }
    const allCoupons = [...this.coupons.values()];
    return { totalSuccessfullyPlacedOrders: this.orders.size, purchasedQuantityByProduct: Object.values(purchased), grossRevenue: this.money(gross), totalDiscountsGranted: this.money(discounts), netRevenue: this.money(gross - discounts), coupons: { generated: allCoupons.length, available: allCoupons.filter(c => c.status === 'AVAILABLE').length, redeemed: allCoupons.filter(c => c.status === 'REDEEMED').length }, currency: 'USD' };
  }
  private validateProductQuantity(productId: number, quantity: number) { if (!Number.isInteger(productId) || !this.products.has(productId)) throw this.err(404, 'PRODUCT_NOT_FOUND', `Product ${productId} was not found`); if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw this.err(400, 'INVALID_QUANTITY', 'Quantity must be an integer between 1 and 100'); }
  private requireOpenCart(id: string) { const cart = this.carts.get(id); if (!cart) throw this.err(404, 'CART_NOT_FOUND', `Cart ${id} was not found`); if (cart.checkedOutOrderId) throw this.err(409, 'CART_ALREADY_CHECKED_OUT', `Cart was checked out as ${cart.checkedOutOrderId}`); return cart; }
  private viewCart(cart: Cart) { const items = cart.items.map(i => { const p = this.products.get(i.productId)!; return { productId: p.id, name: p.name, quantity: i.quantity, unitPrice: this.money(p.priceCents), lineTotal: this.money(p.priceCents * i.quantity), availableInventory: p.inventory }; }); const total = cart.items.reduce((s, i) => s + this.products.get(i.productId)!.priceCents * i.quantity, 0); return { id: cart.id, items, subtotal: this.money(total), currency: 'USD', checkedOutOrderId: cart.checkedOutOrderId }; }
  private withMoney(o: Order) { return { ...o, subtotal: this.money(o.subtotalCents), discount: this.money(o.discountCents), total: this.money(o.totalCents), lines: o.lines.map(l => ({ ...l, unitPrice: this.money(l.unitPriceCents), lineTotal: this.money(l.lineTotalCents) })) }; }
  private money(cents: number) { return (cents / 100).toFixed(2); }
  private err(status: number, code: string, message: string, details?: unknown) { return Object.assign(new Error(message), { status, code, details }); }
}
