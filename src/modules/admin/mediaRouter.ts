import { eq } from 'drizzle-orm';
import { z } from 'zod';
import express, { Router } from 'express';
import type { AppContext } from '../../context.js';
import { mediaFiles } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { requireRole } from '../../middleware/auth.js';
import { assetUrl } from '../catalog/view.js';
import { validate } from '../../middleware/validate.js';

export const MEDIA_MAX_BYTES = 4 * 1024 * 1024;

/** The photo types the shop accepts, the extension they are served under, and how each file must begin. */
const TYPES: Record<string, { ext: string; looksRight(b: Buffer): boolean }> = {
  'image/jpeg': { ext: 'jpg', looksRight: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', looksRight: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { ext: 'webp', looksRight: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
};
const BY_EXT = new Map(Object.entries(TYPES).map(([type, t]) => [t.ext, type]));
const NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|png|webp)$/;

/** Admin upload: the request body is the photo itself, sent with its own content type. */
export function adminMediaRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  router.post(
    '/admin/media',
    ...ctx.member,
    requireRole('admin'),
    express.raw({ type: () => true, limit: MEDIA_MAX_BYTES }),
    async (req, res) => {
      const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      const kind = TYPES[type];
      if (!kind) throw new AppError('unsupported_media_type', 415, 'Upload a JPG, PNG or WebP photo');
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) throw new AppError('validation_failed', 400, 'The photo is empty');
      if (!kind.looksRight(body)) throw new AppError('validation_failed', 400, 'This file is not a real photo of that type');
      res.status(201).json(await store(type, body, req.user!.id));
    },
  );

  // A photo from a web link (e.g. a CSV import's photo column): downloaded by the server, then stored like an upload.
  // The type comes from the file's own bytes, not the link or the remote server's headers.
  router.post('/admin/media/from-url', ...ctx.member, requireRole('admin'), validate({ body: z.object({ url: z.string().trim().min(1).max(2000) }) }), async (req, res) => {
    const { url } = req.body as { url: string };
    const body = await ctx.imageFetcher(url);
    const type = Object.keys(TYPES).find((t) => TYPES[t]!.looksRight(body));
    if (!type) throw new AppError('validation_failed', 400, 'That link is not a JPG, PNG or WebP photo');
    ctx.logger.info({ host: new URL(url).host, actorId: req.user!.id }, 'Photo downloaded from a link');
    res.status(201).json(await store(type, body, req.user!.id));
  });

  async function store(type: string, body: Buffer, actorId: string) {
    const [row] = await db.insert(mediaFiles).values({ contentType: type, bytes: body, size: body.length, uploadedBy: actorId }).returning({ id: mediaFiles.id });
    const path = `media/${row!.id}.${TYPES[type]!.ext}`;
    ctx.logger.info({ mediaId: row!.id, bytes: body.length, actorId }, 'Photo uploaded');
    return { path, url: assetUrl(ctx.config.assetBaseUrl, path) };
  }
  return router;
}

/** Public, not rate limited: photos never change under a name, so browsers and CDNs may keep them for a year. */
export function publicMediaRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  router.get('/media/:name', async (req, res) => {
    const m = NAME.exec(String(req.params.name));
    if (!m) throw new AppError('not_found', 404, 'Not found');
    const [row] = await db.select({ contentType: mediaFiles.contentType, bytes: mediaFiles.bytes }).from(mediaFiles).where(eq(mediaFiles.id, m[1]!));
    if (!row || BY_EXT.get(m[2]!) !== row.contentType) throw new AppError('not_found', 404, 'Not found');
    res.setHeader('Content-Type', row.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // The shop runs on another origin and shows these in <img>.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(row.bytes);
  });
  return router;
}
