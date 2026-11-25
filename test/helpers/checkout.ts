import { randomUUID } from 'node:crypto';
import type { Database } from '../../src/db/client.js';

export const JERSEY = 'cambodia-national-team-home-jersey-varaman';
export const BOOT = 'puma-ultra-5-carbon-speed-fg';
export const PAYMENTS_DEFAULT = { aba_khqr: true, card: true, acleda: false, wing: false, cash_on_pickup: false };

export async function variantId(database: Database, slug: string, size?: string): Promise<string> {
  const r = await database.pool.query(
    `select v.id from variants v join products p on p.id = v.product_id where p.slug = $1 ${size ? 'and v.size_label = $2' : ''} order by v.size_sort limit 1`,
    size ? [slug, size] : [slug],
  );
  return r.rows[0].id;
}

/** A real Phnom Penh district + commune pair from the seeded gazetteer. */
export async function phnomPenhAddress(database: Database) {
  const r = await database.pool.query(
    `select d.code as district, c.code as commune from geo_districts d join geo_communes c on c.district_code = d.code where d.province_code = '12' order by d.code, c.code limit 1`,
  );
  return {
    recipientName: 'Sok Dara',
    phone: '012 345 678',
    provinceCode: '12',
    districtCode: r.rows[0].district as string,
    communeCode: r.rows[0].commune as string,
    street: 'St 271, #12',
    landmark: 'Near the market',
  };
}

export function guestOrder(address: Awaited<ReturnType<typeof phnomPenhAddress>>, over: Record<string, unknown> = {}) {
  return {
    contact: { name: 'Sok Dara', phone: '012 345 678', email: 'dara@example.com', channel: 'telegram' },
    fulfillment: 'delivery',
    shippingMethodId: 'pp_rider',
    address,
    paymentMethod: 'aba_khqr',
    acceptTerms: true,
    ...over,
  };
}

export const idem = () => ({ 'Idempotency-Key': randomUUID() });

export async function setStockAt(database: Database, variant: string, perBranch: Record<string, number>): Promise<void> {
  await database.pool.query('update stock set on_hand = 0, reserved = 0, online_buffer = null where variant_id = $1', [variant]);
  for (const [branch, n] of Object.entries(perBranch)) {
    await database.pool.query('update stock set on_hand = $3 where variant_id = $1 and branch_id = $2', [variant, branch, n]);
  }
}

import request from 'supertest';
import type { Express } from 'express';

/** Guest bag with one line → placed order. Returns the agent (cookie jar) and the 201 body. */
export async function placeGuestOrder(
  app: Express,
  address: Awaited<ReturnType<typeof phnomPenhAddress>>,
  line: { variantId: string; qty: number; customPrint?: Record<string, unknown> },
  over: Record<string, unknown> = {},
) {
  const agent = request.agent(app);
  await agent.post('/v1/cart/items').send(line).expect(200);
  const res = await agent.post('/v1/orders').set(idem()).send(guestOrder(address, over)).expect(201);
  return { agent, body: res.body as { order: { number: string; status: string; pricing: { totalCents: number; shippingCents: number } }; payment: { tranId: string; attempt: number } | null; orderAccessToken: string | null } };
}
