import { sql } from 'drizzle-orm';
import type { Exec } from '../../db/exec.js';

export interface VariantInfo {
  variant_id: string;
  variant_status: string;
  price_cents: number;
  compare_at_cents: number | null;
  size_label: string;
  sku: string;
  product_id: string;
  product_slug: string;
  product_status: string;
  is_customizable: boolean;
  name_i18n: { en: string; km?: string };
  brand_slug: string;
  brand_name: string;
  category_slug: string;
  color: string;
  image_path: string | null;
  units: number;
}

/** Everything a cart needs to know about variants: product, price, image and units sellable online. */
export async function variantInfo(db: Exec, variantIds: string[], buffer: number): Promise<Map<string, VariantInfo>> {
  if (variantIds.length === 0) return new Map();
  const rows = await db.execute<VariantInfo & Record<string, unknown>>(sql`
    select v.id as variant_id, v.status as variant_status, v.price_cents, v.compare_at_cents, v.size_label, v.sku,
      p.id as product_id, p.slug as product_slug, p.status as product_status, p.is_customizable, p.name_i18n,
      b.slug as brand_slug, b.name as brand_name, c.slug as category_slug, pc.name as color,
      (select pi.path from product_images pi where pi.product_id = p.id order by (pi.color_id = v.color_id) desc nulls last, pi.sort, pi.id limit 1) as image_path,
      coalesce((select sum(greatest(0, s.on_hand - s.reserved - coalesce(s.online_buffer, ${buffer}))) from stock s where s.variant_id = v.id), 0)::int as units
    from variants v
    join products p on p.id = v.product_id
    join brands b on b.id = p.brand_id
    join categories c on c.id = p.category_id
    join product_colors pc on pc.id = v.color_id
    where v.id in ${variantIds}`);
  return new Map(rows.rows.map((r) => [r.variant_id, r]));
}

export const sellable = (v: VariantInfo | undefined) => v !== undefined && v.variant_status === 'active' && v.product_status === 'active';

