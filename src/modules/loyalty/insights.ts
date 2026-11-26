import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { I18n } from '../../db/schema/index.js';
import { pick, type Lang } from '../catalog/i18n.js';

export interface InsightSlice {
  key: string;
  label: string;
  itemCount: number;
  orderCount: number;
  spendCents: number;
  sharePct: number;
}

export interface Insights {
  totalOrders: number;
  totalItems: number;
  totalSpendCents: number;
  customPrintedCount: number;
  categories: InsightSlice[];
  brands: InsightSlice[];
  favoriteCategory: InsightSlice | null;
  favoriteBrand: InsightSlice | null;
}

/** What a member buys, from their paid orders (refunded orders excluded): spend shares by category and brand. */
export async function memberInsights(db: Db, userId: string, lang: Lang): Promise<Insights> {
  const rows = await db.execute<{ order_id: string; category: string; category_name: I18n | null; brand: string; qty: number; spend: number; printed: boolean }>(sql`
    select o.id as order_id, i.product_snapshot->>'categorySlug' as category, c.name_i18n as category_name,
      i.product_snapshot->>'brand' as brand, i.qty, i.line_total_cents as spend, i.custom_print is not null as printed
    from order_items i join orders o on o.id = i.order_id
    left join categories c on c.slug = i.product_snapshot->>'categorySlug'
    where o.user_id = ${userId} and o.payment_status = 'paid' and o.status not in ('cancelled', 'expired')`);
  const totalSpend = rows.rows.reduce((s, r) => s + r.spend, 0);
  const slices = (keyOf: (r: (typeof rows.rows)[number]) => string, labelOf: (r: (typeof rows.rows)[number]) => string): InsightSlice[] => {
    const map = new Map<string, { label: string; items: number; orders: Set<string>; spend: number }>();
    for (const r of rows.rows) {
      const k = keyOf(r);
      const e = map.get(k) ?? { label: labelOf(r), items: 0, orders: new Set<string>(), spend: 0 };
      e.items += r.qty;
      e.orders.add(r.order_id);
      e.spend += r.spend;
      map.set(k, e);
    }
    return [...map.entries()]
      .map(([key, e]) => ({ key, label: e.label, itemCount: e.items, orderCount: e.orders.size, spendCents: e.spend, sharePct: totalSpend ? Math.round((e.spend / totalSpend) * 100) : 0 }))
      .sort((a, b) => b.spendCents - a.spendCents || a.key.localeCompare(b.key));
  };
  const categories = slices((r) => r.category ?? 'other', (r) => pick(r.category_name, lang) ?? r.category ?? 'Other');
  const brands = slices((r) => (r.brand ?? 'other').toLowerCase(), (r) => r.brand ?? 'Other');
  return {
    totalOrders: new Set(rows.rows.map((r) => r.order_id)).size,
    totalItems: rows.rows.reduce((s, r) => s + r.qty, 0),
    totalSpendCents: totalSpend,
    customPrintedCount: rows.rows.filter((r) => r.printed).reduce((s, r) => s + r.qty, 0),
    categories,
    brands,
    favoriteCategory: categories[0] ?? null,
    favoriteBrand: brands[0] ?? null,
  };
}
