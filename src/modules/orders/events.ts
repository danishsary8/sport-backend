import type { Exec } from '../../db/exec.js';
import { orderEvents, type OrderStatus } from '../../db/schema/index.js';

export interface OrderEventInput {
  orderId: string;
  from?: OrderStatus | null;
  to?: OrderStatus | null;
  kind: 'status' | 'payment' | 'note' | 'flag';
  /** 'system', 'customer', or a staff user id. */
  actor: string;
  note?: string;
}

export async function recordEvent(tx: Exec, e: OrderEventInput): Promise<void> {
  await tx.insert(orderEvents).values({ orderId: e.orderId, fromStatus: e.from ?? null, toStatus: e.to ?? null, kind: e.kind, actor: e.actor, note: e.note ?? null });
}
