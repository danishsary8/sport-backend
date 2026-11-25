import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, type OrderStatus } from '../../src/db/schema/orders.js';
import { assertTransition, canTransition } from '../../src/modules/orders/statusMachine.js';

const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ['confirmed', 'printing', 'expired', 'cancelled'],
  awaiting_pickup_payment: ['ready_for_pickup', 'expired', 'cancelled'],
  confirmed: ['printing', 'ready_for_pickup', 'out_for_delivery', 'cancelled'],
  printing: ['ready_for_pickup', 'out_for_delivery', 'cancelled'],
  ready_for_pickup: ['completed', 'cancelled', 'expired'],
  out_for_delivery: ['delivered'],
  delivered: ['completed'],
  expired: ['confirmed', 'printing'],
  completed: [],
  cancelled: [],
};

describe('order status machine', () => {
  for (const from of ORDER_STATUSES) {
    for (const to of ORDER_STATUSES) {
      const expected = ALLOWED[from].includes(to);
      it(`${from} → ${to} is ${expected ? 'allowed' : 'refused'}`, () => {
        expect(canTransition(from, to)).toBe(expected);
      });
    }
  }

  it('throws invalid_transition for a refused move', () => {
    expect(() => assertTransition('delivered', 'cancelled')).toThrow(expect.objectContaining({ code: 'invalid_transition', status: 409 }));
  });
});
