import type { OrderStatus } from '../../db/schema/orders.js';
import { AppError } from '../../lib/errors.js';

/** Every allowed order status change (spec §11). `expired → confirmed|printing` is the paid-after-expiry path. */
export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ['confirmed', 'printing', 'expired', 'cancelled'],
  awaiting_pickup_payment: ['ready_for_pickup', 'expired', 'cancelled'],
  confirmed: ['printing', 'ready_for_pickup', 'out_for_delivery', 'cancelled'],
  printing: ['ready_for_pickup', 'out_for_delivery', 'cancelled'],
  ready_for_pickup: ['completed', 'cancelled'],
  out_for_delivery: ['delivered'],
  delivered: ['completed'],
  expired: ['confirmed', 'printing'],
  completed: [],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError('invalid_transition', 409, `An order can't go from ${from.replaceAll('_', ' ')} to ${to.replaceAll('_', ' ')}`, { from, to });
  }
}
