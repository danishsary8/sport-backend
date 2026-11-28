import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { toNinety } from '../catalog/price.js';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Db } from '../../db/client.js';
import {
  branches,
  brands,
  categories,
  PRODUCT_STATUSES,
  productColors,
  productImages,
  products,
  stock,
  variants,
} from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { exportCatalogCsv, exportProductsCsv, importProductsCsv } from './productsCsv.js';
import { assetUrl } from '../catalog/view.js';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { escapeLike } from '../catalog/listing.js';
import { bySeasonDesc, continentSql, CONTINENTS, seasonLabel, seasonSql } from '../catalog/derived.js';
import { sizeSort } from '../catalog/sizes.js';
import { skuBase } from '../catalog/sku.js';
import type { Tx } from '../stock/service.js';

/** Catalog image paths are relative to ASSET_BASE_URL: no scheme, no leading slash, no "..". */
export const imagePath = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[a-z0-9][a-z0-9/_.-]*$/, 'Use a relative path like catalog/name.jpg (lowercase letters, digits, / _ . -)')
  .refine((p) => !p.split('/').includes('..'), 'Must not contain ".."');


const i18n = z.object({ en: z.string().trim().min(1).max(500), km: z.string().trim().max(500).optional() });
const slug = z.string().trim().min(2).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and dashes');
/** Every selling price ends in .90 ($12 → $11.90); see toNinety. */
const priceCents = z.number().int().min(0).max(10_000_000).transform(toNinety);
/** A "was" price is kept exactly as entered. */
const wasCents = z.number().int().min(0).max(10_000_000);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const comparePriceOk = (v: { priceCents?: number; compareAtCents?: number | null }) =>
  v.compareAtCents === undefined || v.compareAtCents === null || v.priceCents === undefined || v.compareAtCents > v.priceCents;
const compareMessage = { message: 'Compare-at price must be higher than the price', path: ['compareAtCents'] };

const variantInput = z
  .object({
    color: z.string().trim().min(1).max(80),
    size: z.string().trim().min(1).max(40),
    sku: z.string().trim().min(2).max(40).regex(/^[A-Z0-9-]+$/, 'Use A-Z, 0-9 and dashes').optional(),
    priceCents,
    compareAtCents: wasCents.nullable().optional(),
  })
  .refine(comparePriceOk, compareMessage);

const productFields = {
  brandSlug: slug,
  categorySlug: slug,
  name: i18n,
  shortName: i18n.nullable(),
  description: i18n.nullable(),
  highlights: z.array(z.string().trim().min(1).max(200)).max(12),
  specs: z.record(z.string(), z.string().max(300)),
  attributes: z.record(z.string(), z.unknown()),
  flags: z.record(z.string(), z.boolean()),
  isCustomizable: z.boolean(),
  heroTagline: z.string().trim().max(120).nullable(),
  status: z.enum(PRODUCT_STATUSES),
};

const createSchema = z.object({
  slug,
  ...productFields,
  shortName: productFields.shortName.optional(),
  description: productFields.description.optional(),
  highlights: productFields.highlights.default([]),
  specs: productFields.specs.default({}),
  attributes: productFields.attributes.default({}),
  flags: productFields.flags.default({}),
  isCustomizable: productFields.isCustomizable.default(false),
  heroTagline: productFields.heroTagline.optional(),
  status: productFields.status.default('draft'),
  colors: z.array(z.object({ name: z.string().trim().min(1).max(80), swatchHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() })).min(1).max(20),
  variants: z.array(variantInput).min(1).max(100),
  images: z.array(z.object({ path: imagePath, color: z.string().trim().max(80).optional(), alt: z.string().max(200).optional() })).max(30).default([]),
});

const patchSchema = z
  .object(productFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const variantPatchSchema = z
  .object({ priceCents, compareAtCents: wasCents.nullable(), status: z.enum(['active', 'inactive']) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  category: z.string().trim().max(80).optional(),
  // Sub-types (one value each): stored attributes, and the season/continent the shop works out.
  league: z.string().trim().max(80).optional(),
  kitType: z.string().trim().max(80).optional(),
  surface: z.string().trim().max(80).optional(),
  garmentType: z.string().trim().max(80).optional(),
  season: z.string().trim().max(20).optional(),
  continent: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** The product list's filters as SQL over `products` and `categories`; shared by the list and the CSV export. */
type ProductFilterInput = {
  q?: string;
  status?: (typeof PRODUCT_STATUSES)[number];
  category?: string;
  ids?: string[];
} & Partial<Record<(typeof SUBTYPE_KEYS)[number], string>>;

export function productFilter({ q, status, category, ids, ...subtypes }: ProductFilterInput): SQL | undefined {
  const conditions: SQL[] = [];
  for (const key of ['league', 'kitType', 'surface', 'garmentType'] as const) {
    if (subtypes[key]) conditions.push(sql`${products.attributes}->>${key} = ${subtypes[key]}`);
  }
  // Worked out per product exactly as the shop's listing does (derived.ts uses the alias p).
  if (subtypes.season) conditions.push(sql`exists (select 1 from products p where p.id = ${products.id} and ${seasonSql} = ${subtypes.season})`);
  if (subtypes.continent) conditions.push(sql`exists (select 1 from products p where p.id = ${products.id} and ${continentSql} = ${subtypes.continent})`);
  if (ids) conditions.push(inArray(products.id, ids));
  if (status) conditions.push(eq(products.status, status));
  if (category) conditions.push(eq(categories.slug, category));
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    conditions.push(or(ilike(products.slug, pattern), ilike(products.searchText, pattern))!);
  }
  return conditions.length ? and(...conditions) : undefined;
}

/** Sub-type filters, in the order the admin offers them. */
const SUBTYPE_KEYS = ['league', 'continent', 'season', 'kitType', 'surface', 'garmentType'] as const;
const SUBTYPE_TITLES: Record<(typeof SUBTYPE_KEYS)[number], string> = {
  league: 'League',
  continent: 'Continent',
  season: 'Season',
  kitType: 'Kit',
  surface: 'Surface',
  garmentType: 'Type',
};
const GARMENT_NAMES: Record<string, string> = { jersey: 'Team jerseys', jacket: 'Paddock jackets' };

const exportSchema = listSchema.omit({ page: true, pageSize: true }).extend({
  format: z.enum(['prices', 'products']).default('prices'),
  /** Comma-separated product ids: export just these (the ticked rows). */
  ids: z
    .string()
    .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.string().uuid('Not a product id')).min(1).max(200))
    .optional(),
});

const allPricesSchema = z.object({ priceCents, compareAtCents: wasCents.nullable().optional() });

function invalid(path: string, message: string) {
  return new AppError('validation_failed', 400, 'Validation failed', [{ path, message }]);
}

async function idOf(tx: Tx | Db, table: typeof brands | typeof categories, value: string, path: string): Promise<string> {
  const [row] = await tx.select({ id: table.id }).from(table).where(eq(table.slug, value));
  if (!row) throw invalid(path, 'Not found');
  return row.id;
}

/** Keeps the search index text in sync with names, brand, club, league, colours and category. */
async function refreshSearchText(tx: Tx, productId: string): Promise<void> {
  await tx.execute(sql`
    update products p set search_text = unaccent(lower(concat_ws(' ',
      p.name_i18n->>'en', p.short_name_i18n->>'en', b.name, p.attributes->>'club', p.attributes->>'league',
      (select string_agg(pc.name, ' ') from product_colors pc where pc.product_id = p.id), c.slug))),
      updated_at = now()
    from brands b, categories c
    where p.id = ${productId} and b.id = p.brand_id and c.id = p.category_id`);
}

async function addVariant(
  tx: Tx,
  productId: string,
  productSlug: string,
  colorIds: Map<string, string>,
  v: z.infer<typeof variantInput>,
  position: number,
): Promise<string> {
  const colorId = colorIds.get(v.color.toLowerCase());
  if (!colorId) throw invalid('variants', `Unknown colour "${v.color}"`);
  let sku = v.sku ?? skuBase(productSlug, v.size);
  if (!v.sku) {
    for (let n = 2; (await tx.select({ id: variants.id }).from(variants).where(eq(variants.sku, sku))).length > 0; n += 1) {
      sku = `${skuBase(productSlug, v.size)}-${n}`;
    }
  }
  const [row] = await tx
    .insert(variants)
    .values({ productId, colorId, sizeLabel: v.size, sizeSort: sizeSort(v.size, position), sku, priceCents: v.priceCents, compareAtCents: v.compareAtCents ?? null })
    .returning({ id: variants.id });
  const branchRows = await tx.select({ id: branches.id }).from(branches);
  await tx.insert(stock).values(branchRows.map((b) => ({ variantId: row!.id, branchId: b.id })));
  return row!.id;
}

/** Translates unique-constraint failures into clear 409s. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return (e.code ?? e.cause?.code) === '23505';
}

function mapUnique(error: unknown): never {
  const e = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const pg = e.code ? e : e.cause;
  if (pg?.code === '23505') {
    if (pg.constraint?.includes('slug')) throw new AppError('slug_taken', 409, 'That product URL is already used');
    if (pg.constraint?.includes('sku')) throw new AppError('sku_taken', 409, 'That SKU is already used');
    throw new AppError('duplicate', 409, 'Duplicate size or colour');
  }
  throw error;
}

async function adminView(db: Db, id: string, base: string) {
  const [product] = await db.select().from(products).where(eq(products.id, id));
  if (!product) throw new AppError('not_found', 404, 'Product not found');
  const [colorRows, variantRows, imageRows] = await Promise.all([
    db.select().from(productColors).where(eq(productColors.productId, id)),
    db.select().from(variants).where(eq(variants.productId, id)).orderBy(variants.sizeSort),
    db.select().from(productImages).where(eq(productImages.productId, id)).orderBy(productImages.sort),
  ]);
  return { ...product, colors: colorRows, variants: variantRows, images: imageRows.map((i) => ({ ...i, url: assetUrl(base, i.path) })) };
}

export function adminProductsRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  const admin = [...ctx.member, requireRole('admin')];

  router.use('/admin/products', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/admin/products', ...admin, validate({ query: listSchema }), async (req, res) => {
    const { page, pageSize, ...filters } = req.query as unknown as z.infer<typeof listSchema>;
    const where = productFilter(filters);
    // What a manager needs to see at a glance: photos, price range, how many sizes and how much stock.
    const firstImage = (n: number) => sql<string | null>`(select i.path from product_images i where i.product_id = ${products.id} order by i.sort, i.id offset ${n} limit 1)`;
    const [rows, [total]] = await Promise.all([
      db
        .select({
          product: products,
          brandName: brands.name,
          categorySlug: categories.slug,
          image: firstImage(0),
          hoverImage: firstImage(1),
          imageCount: sql<number>`(select count(*) from product_images i where i.product_id = ${products.id})::int`,
          priceMinCents: sql<number | null>`(select min(v.price_cents) from variants v where v.product_id = ${products.id})::int`,
          priceMaxCents: sql<number | null>`(select max(v.price_cents) from variants v where v.product_id = ${products.id})::int`,
          variantCount: sql<number>`(select count(*) from variants v where v.product_id = ${products.id})::int`,
          onHand: sql<number>`(select coalesce(sum(s.on_hand), 0) from stock s join variants v on v.id = s.variant_id where v.product_id = ${products.id})::int`,
        })
        .from(products)
        .innerJoin(brands, eq(brands.id, products.brandId))
        .innerJoin(categories, eq(categories.id, products.categoryId))
        .where(where)
        .orderBy(desc(products.updatedAt), products.slug)
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ n: count() }).from(products).innerJoin(categories, eq(categories.id, products.categoryId)).where(where),
    ]);
    const base = ctx.config.assetBaseUrl;
    res.json({
      products: rows.map(({ product, image, hoverImage, ...r }) => ({ ...product, ...r, imageUrl: assetUrl(base, image), hoverImageUrl: assetUrl(base, hoverImage) })),
      total: total?.n ?? 0,
      page,
      pageSize,
    });
  });

  // Follows the list's filters. "prices": one row per size (the price-update file); "products": one row per
  // product colour in the new-product import columns, plus slug and status.
  router.get('/admin/products/export.csv', ...admin, validate({ query: exportSchema }), async (req, res) => {
    const { format, ...filters } = req.query as unknown as z.infer<typeof exportSchema>;
    const where = productFilter(filters) ?? sql`true`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sport-heaven-${format}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(format === 'products' ? await exportCatalogCsv(db, where) : await exportProductsCsv(db, where));
  });

  router.post(
    '/admin/products/import',
    ...admin,
    express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }),
    validate({ query: z.object({ apply: z.enum(['true', 'false']).optional() }), body: z.string().min(1, 'Send the CSV file as the request body') }),
    async (req, res) => {
      const apply = (req.query as { apply?: string }).apply === 'true';
      const result = await importProductsCsv(db, req.body as string, apply);
      if (result.applied) ctx.logger.info({ actorId: req.user!.id, changes: result.changes.length }, 'Product prices imported');
      res.json(result);
    },
  );

  // The sub-types a category's products have (every status), with counts, for the admin's Type filter.
  router.get('/admin/products/subtypes', ...admin, validate({ query: z.object({ category: z.string().trim().min(1).max(80) }) }), async (req, res) => {
    const { category } = req.query as { category: string };
    const rows = await db.execute<Record<(typeof SUBTYPE_KEYS)[number], string | null>>(sql`
      select p.attributes->>'league' as league, p.attributes->>'kitType' as "kitType", p.attributes->>'surface' as surface,
        p.attributes->>'garmentType' as "garmentType", ${seasonSql} as season, ${continentSql} as continent
      from products p join categories c on c.id = p.category_id where c.slug = ${category}`);
    const label = (key: (typeof SUBTYPE_KEYS)[number], v: string) =>
      key === 'season' ? seasonLabel(v) : key === 'continent' ? (CONTINENTS.find((c) => c.value === v)?.label ?? v) : key === 'garmentType' ? (GARMENT_NAMES[v] ?? v) : v;
    const order = (key: (typeof SUBTYPE_KEYS)[number]) => (a: { value: string; label: string }, b: { value: string; label: string }) =>
      key === 'season' ? bySeasonDesc(a.value, b.value) : key === 'continent' ? CONTINENTS.findIndex((c) => c.value === a.value) - CONTINENTS.findIndex((c) => c.value === b.value) : a.label.localeCompare(b.label);
    const groups = SUBTYPE_KEYS.map((key) => {
      const counts = new Map<string, number>();
      for (const r of rows.rows) if (r[key]) counts.set(r[key]!, (counts.get(r[key]!) ?? 0) + 1);
      const options = [...counts].map(([value, count]) => ({ value, label: label(key, value), count })).sort(order(key));
      return { key, title: SUBTYPE_TITLES[key], options };
    }).filter((g) => g.options.length > 0);
    res.json({ groups });
  });

  router.get('/admin/products/:id', ...admin, async (req, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) throw new AppError('not_found', 404, 'Product not found');
    res.json({ product: await adminView(db, id, ctx.config.assetBaseUrl) });
  });

  router.post('/admin/products', ...admin, validate({ body: createSchema }), async (req, res) => {
    const input = req.body as z.infer<typeof createSchema>;
    const id = await db
      .transaction(async (tx) => {
        const [product] = await tx
          .insert(products)
          .values({
            slug: input.slug,
            brandId: await idOf(tx, brands, input.brandSlug, 'brandSlug'),
            categoryId: await idOf(tx, categories, input.categorySlug, 'categorySlug'),
            nameI18n: input.name,
            shortNameI18n: input.shortName ?? null,
            descriptionI18n: input.description ?? null,
            highlights: input.highlights,
            specs: input.specs,
            attributes: input.attributes,
            flags: input.flags,
            isCustomizable: input.isCustomizable,
            heroTagline: input.heroTagline ?? null,
            status: input.status,
          })
          .returning({ id: products.id });
        const productId = product!.id;
        const colorIds = new Map<string, string>();
        const names = input.colors.map((c) => c.name.toLowerCase());
        const dup = names.find((n, i) => names.indexOf(n) !== i);
        if (dup) throw new AppError('color_exists', 400, `The colour "${dup}" is listed twice`);
        for (const img of input.images) {
          if (img.color && !names.includes(img.color.toLowerCase())) {
            throw new AppError('validation_failed', 400, 'Validation failed', [{ path: 'images', message: `Unknown colour "${img.color}"` }]);
          }
        }
        for (const [sort, c] of input.colors.entries()) {
          const [row] = await tx.insert(productColors).values({ productId, name: c.name, swatchHex: c.swatchHex ?? null, sort }).returning({ id: productColors.id });
          colorIds.set(c.name.toLowerCase(), row!.id);
        }
        for (const [position, v] of input.variants.entries()) await addVariant(tx, productId, input.slug, colorIds, v, position);
        for (const [sort, img] of input.images.entries()) {
          await tx.insert(productImages).values({ productId, path: img.path, alt: img.alt ?? null, sort, colorId: img.color ? (colorIds.get(img.color.toLowerCase()) ?? null) : null });
        }
        await refreshSearchText(tx, productId);
        return productId;
      })
      .catch(mapUnique);
    ctx.logger.info({ productId: id, actorId: req.user!.id }, 'Product created');
    res.status(201).json({ product: await adminView(db, id, ctx.config.assetBaseUrl) });
  });

  router.patch('/admin/products/:id', ...admin, validate({ body: patchSchema }), async (req, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) throw new AppError('not_found', 404, 'Product not found');
    const patch = req.body as z.infer<typeof patchSchema>;
    await db
      .transaction(async (tx) => {
        const { brandSlug, categorySlug, name, shortName, description, ...rest } = patch;
        const values: Record<string, unknown> = { ...rest };
        if (brandSlug) values.brandId = await idOf(tx, brands, brandSlug, 'brandSlug');
        if (categorySlug) values.categoryId = await idOf(tx, categories, categorySlug, 'categorySlug');
        if (name) values.nameI18n = name;
        if (shortName !== undefined) values.shortNameI18n = shortName;
        if (description !== undefined) values.descriptionI18n = description;
        const updated = await tx.update(products).set(values).where(eq(products.id, id)).returning({ id: products.id });
        if (updated.length === 0) throw new AppError('not_found', 404, 'Product not found');
        await refreshSearchText(tx, id);
      })
      .catch(mapUnique);
    ctx.logger.info({ productId: id, actorId: req.user!.id, change: patch }, 'Product updated');
    res.json({ product: await adminView(db, id, ctx.config.assetBaseUrl) });
  });

  router.post('/admin/products/:id/variants', ...admin, validate({ body: variantInput }), async (req, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) throw new AppError('not_found', 404, 'Product not found');
    await db
      .transaction(async (tx) => {
        const [product] = await tx.select({ slug: products.slug }).from(products).where(eq(products.id, id));
        if (!product) throw new AppError('not_found', 404, 'Product not found');
        const colorRows = await tx.select().from(productColors).where(eq(productColors.productId, id));
        const colorIds = new Map(colorRows.map((c) => [c.name.toLowerCase(), c.id]));
        const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(variants).where(eq(variants.productId, id));
        await addVariant(tx, id, product.slug, colorIds, req.body, n);
        await refreshSearchText(tx, id);
      })
      .catch(mapUnique);
    ctx.logger.info({ productId: id, actorId: req.user!.id, variant: req.body }, 'Variant added');
    res.status(201).json({ product: await adminView(db, id, ctx.config.assetBaseUrl) });
  });

  // Deletes a product for good, with its sizes, stock, photos and wishlist entries. Refused when any order (or
  // return exchange) points at one of its sizes, so order history stays intact; archive those instead.
  router.delete('/admin/products/:id', ...admin, async (req, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) throw new AppError('not_found', 404, 'Product not found');
    const name = await db.transaction(async (tx) => {
      const [p] = await tx.select({ id: products.id, name: products.nameI18n }).from(products).where(eq(products.id, id)).for('update');
      if (!p) throw new AppError('not_found', 404, 'Product not found');
      const used = await tx.execute<{ used: boolean }>(sql`select exists (
        select 1 from order_items oi join variants v on v.id = oi.variant_id where v.product_id = ${id}
        union all select 1 from rma_items ri join variants v on v.id = ri.exchange_variant_id where v.product_id = ${id}) as used`);
      if (used.rows[0]?.used) throw new AppError('product_has_orders', 409, 'This product has orders, so it cannot be deleted. Archive it instead.');
      await tx.delete(products).where(eq(products.id, id));
      return p.name.en;
    });
    ctx.logger.info({ productId: id, name, actorId: req.user!.id }, 'Product deleted');
    res.status(204).end();
  });

  // One price (and optional "was" price) for every size of the product, in one transaction.
  router.put('/admin/products/:id/prices', ...admin, validate({ body: allPricesSchema }), async (req, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) throw new AppError('not_found', 404, 'Product not found');
    const body = req.body as z.infer<typeof allPricesSchema>;
    const compareAtCents = body.compareAtCents ?? null;
    if (compareAtCents !== null && compareAtCents <= body.priceCents) throw invalid('compareAtCents', 'Compare-at price must be higher than the price');
    const changed = await db.transaction(async (tx) => {
      const [p] = await tx.select({ id: products.id }).from(products).where(eq(products.id, id)).for('update');
      if (!p) throw new AppError('not_found', 404, 'Product not found');
      const rows = await tx.update(variants).set({ priceCents: body.priceCents, compareAtCents }).where(eq(variants.productId, id)).returning({ id: variants.id });
      await tx.update(products).set({ updatedAt: sql`now()` }).where(eq(products.id, id));
      return rows.length;
    });
    ctx.logger.info({ productId: id, actorId: req.user!.id, priceCents: body.priceCents, compareAtCents, sizes: changed }, 'Price set for all sizes');
    res.json({ product: await adminView(db, id, ctx.config.assetBaseUrl) });
  });

  router.put('/admin/products/:id/variants/:variantId', ...admin, validate({ body: variantPatchSchema }), async (req, res) => {
    const id = String(req.params.id);
    const variantId = String(req.params.variantId);
    if (!UUID.test(id) || !UUID.test(variantId)) throw new AppError('not_found', 404, 'Variant not found');
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(variants).where(and(eq(variants.id, variantId), eq(variants.productId, id))).for('update');
      if (!current) throw new AppError('not_found', 404, 'Variant not found');
      const next = { ...current, ...req.body };
      if (next.compareAtCents !== null && next.compareAtCents <= next.priceCents) {
        throw invalid('compareAtCents', 'Compare-at price must be higher than the price');
      }
      await tx.update(variants).set(req.body).where(eq(variants.id, variantId));
      await tx.update(products).set({ updatedAt: sql`now()` }).where(eq(products.id, id));
    });
    ctx.logger.info({ productId: id, variantId, actorId: req.user!.id, change: req.body }, 'Variant updated');
    res.json({ product: await adminView(db, id, ctx.config.assetBaseUrl) });
  });

  // ---- Colours and photos after creation -------------------------------------------------------------
  const colorInput = z.object({ name: z.string().trim().min(1).max(80), swatchHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional() });
  const productIdOf = (req: Request): string => {
    const id = String(req.params.id);
    if (!UUID.test(id)) throw new AppError('not_found', 404, 'Product not found');
    return id;
  };
  const lockProduct = async (tx: Tx, id: string) => {
    const [p] = await tx.select({ id: products.id }).from(products).where(eq(products.id, id)).for('update');
    if (!p) throw new AppError('not_found', 404, 'Product not found');
  };
  const colourTaken = async (tx: Tx, productId: string, name: string, exceptId?: string) => {
    const rows = await tx.select({ id: productColors.id, name: productColors.name }).from(productColors).where(eq(productColors.productId, productId));
    if (rows.some((c) => c.id !== exceptId && c.name.toLowerCase() === name.toLowerCase())) {
      throw new AppError('color_exists', 409, `This product already has the colour "${name}"`);
    }
  };

  router.post('/admin/products/:id/colors', ...admin, validate({ body: colorInput }), async (req, res) => {
    const id = productIdOf(req);
    const input = req.body as z.infer<typeof colorInput>;
    await db.transaction(async (tx) => {
      await lockProduct(tx, id);
      await colourTaken(tx, id, input.name);
      const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(productColors).where(eq(productColors.productId, id));
      await tx.insert(productColors).values({ productId: id, name: input.name, swatchHex: input.swatchHex ?? null, sort: n });
      await tx.update(products).set({ updatedAt: sql`now()` }).where(eq(products.id, id));
      await refreshSearchText(tx, id);
    });
    ctx.logger.info({ productId: id, actorId: req.user!.id, color: input.name }, 'Colour added');
    res.status(201).json({ product: await adminView(db, id, ctx.config.assetBaseUrl) });
  });

  router.patch(
    '/admin/products/:id/colors/:colorId',
    ...admin,
    validate({ body: colorInput.extend({ sort: z.number().int().min(0).max(100) }).partial().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' }) }),
    async (req, res) => {
      const id = productIdOf(req);
      const colorId = String(req.params.colorId);
      if (!UUID.test(colorId)) throw new AppError('not_found', 404, 'Colour not found');
      const input = req.body as { name?: string; swatchHex?: string | null; sort?: number };
      await db.transaction(async (tx) => {
        await lockProduct(tx, id);
        if (input.name) await colourTaken(tx, id, input.name, colorId);
        const updated = await tx
          .update(productColors)
          .set(input)
          .where(and(eq(productColors.id, colorId), eq(productColors.productId, id)))
          .returning({ id: productColors.id });
        if (updated.length === 0) throw new AppError('not_found', 404, 'Colour not found');
        await tx.update(products).set({ updatedAt: sql`now()` }).where(eq(products.id, id));
        await refreshSearchText(tx, id);
      });
      ctx.logger.info({ productId: id, colorId, actorId: req.user!.id, change: input }, 'Colour updated');
      res.json({ product: await adminView(db, id, ctx.config.assetBaseUrl) });
    },
  );

  router.delete('/admin/products/:id/colors/:colorId', ...admin, async (req, res) => {
    const id = productIdOf(req);
    const colorId = String(req.params.colorId);
    if (!UUID.test(colorId)) throw new AppError('not_found', 404, 'Colour not found');
    await db.transaction(async (tx) => {
      await lockProduct(tx, id);
      const [used] = await tx.select({ n: count() }).from(variants).where(eq(variants.colorId, colorId));
      if ((used?.n ?? 0) > 0) throw new AppError('color_in_use', 409, 'Sizes still use this colour. Switch them off instead of deleting the colour.');
      const removed = await tx.delete(productColors).where(and(eq(productColors.id, colorId), eq(productColors.productId, id))).returning({ id: productColors.id });
      if (removed.length === 0) throw new AppError('not_found', 404, 'Colour not found');
      await tx.update(products).set({ updatedAt: sql`now()` }).where(eq(products.id, id));
      await refreshSearchText(tx, id);
    });
    ctx.logger.info({ productId: id, colorId, actorId: req.user!.id }, 'Colour deleted');
    res.json({ product: await adminView(db, id, ctx.config.assetBaseUrl) });
  });

  const imagesInput = z.object({
    images: z.array(z.object({ path: imagePath, color: z.string().trim().max(80).optional(), alt: z.string().max(200).optional() })).max(30),
  });
  router.put('/admin/products/:id/images', ...admin, validate({ body: imagesInput }), async (req, res) => {
    const id = productIdOf(req);
    const { images } = req.body as z.infer<typeof imagesInput>;
    await db.transaction(async (tx) => {
      await lockProduct(tx, id);
      const colorRows = await tx.select().from(productColors).where(eq(productColors.productId, id));
      const colorIds = new Map(colorRows.map((c) => [c.name.toLowerCase(), c.id]));
      for (const img of images) {
        if (img.color && !colorIds.has(img.color.toLowerCase())) throw invalid('images', `Unknown colour "${img.color}"`);
      }
      await tx.delete(productImages).where(eq(productImages.productId, id));
      for (const [sort, img] of images.entries()) {
        await tx.insert(productImages).values({ productId: id, path: img.path, alt: img.alt ?? null, sort, colorId: img.color ? colorIds.get(img.color.toLowerCase())! : null });
      }
      await tx.update(products).set({ updatedAt: sql`now()` }).where(eq(products.id, id));
    });
    ctx.logger.info({ productId: id, actorId: req.user!.id, images: images.length }, 'Product photos replaced');
    res.json({ product: await adminView(db, id, ctx.config.assetBaseUrl) });
  });

  // ---- Brands and categories ------------------------------------------------------------------------------
  router.get('/admin/brands', ...admin, async (_req, res) => {
    res.json({ brands: await db.select().from(brands).orderBy(asc(brands.sort), asc(brands.name)) });
  });

  const brandInput = z.object({ slug, name: z.string().trim().min(1).max(80), logoPath: imagePath.nullable().optional() });
  router.post('/admin/brands', ...admin, validate({ body: brandInput }), async (req, res) => {
    const input = req.body as z.infer<typeof brandInput>;
    const [brand] = await db
      .insert(brands)
      .values({ slug: input.slug, name: input.name, logoPath: input.logoPath ?? null })
      .returning()
      .catch((e: unknown) => {
        if (isUniqueViolation(e)) throw new AppError('slug_taken', 409, 'That brand already exists');
        throw e;
      });
    ctx.logger.info({ actorId: req.user!.id, brand: input.slug }, 'Brand created');
    res.status(201).json({ brand });
  });

  router.get('/admin/categories', ...admin, async (_req, res) => {
    res.json({ categories: await db.select().from(categories).orderBy(asc(categories.sort), asc(categories.slug)) });
  });

  const categoryInput = z.object({ slug, name: i18n, parentSlug: slug.nullable().optional() });
  router.post('/admin/categories', ...admin, validate({ body: categoryInput }), async (req, res) => {
    const input = req.body as z.infer<typeof categoryInput>;
    const parentId = input.parentSlug ? await idOf(db, categories, input.parentSlug, 'parentSlug') : null;
    const [category] = await db
      .insert(categories)
      .values({ slug: input.slug, nameI18n: input.name, parentId })
      .returning()
      .catch((e: unknown) => {
        if (isUniqueViolation(e)) throw new AppError('slug_taken', 409, 'That category already exists');
        throw e;
      });
    ctx.logger.info({ actorId: req.user!.id, category: input.slug }, 'Category created');
    res.status(201).json({ category });
  });

  return router;
}
