import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { createSystemHealth } from '../../src/modules/health/system/service.js';
import { bearer, memberApp } from '../helpers/app.js';
import { staffToken } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let admin: string;

beforeAll(async () => {
  database = await testDb();
  ctx = memberApp(database);
  admin = await staffToken(ctx.app, database, ctx.fake, 'sh-admin', 'admin');
});
afterAll(closeTestDb);

describe('system health (admin)', () => {
  it('reports the API and database as operational', async () => {
    const res = await request(ctx.app).get('/v1/admin/system-health').set(bearer(admin)).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ overallStatus: 'operational', database: { status: 'connected', engine: 'PostgreSQL' } });
    expect(typeof res.body.database.latencyMs).toBe('number');
    expect(res.body.database.pool).toEqual({ total: expect.any(Number), idle: expect.any(Number), waiting: expect.any(Number) });
    expect(res.body.recentChecks.length).toBeGreaterThan(0);
  });

  it('is for admins only', async () => {
    const staff = await staffToken(ctx.app, database, ctx.fake, 'sh-staff', 'staff');
    await request(ctx.app).get('/v1/admin/system-health').set(bearer(staff)).expect(403);
    await request(ctx.app).get('/v1/admin/system-health').expect(401);
  });

  it('returns latency series and an alert verdict', async () => {
    for (let i = 0; i < 6; i++) await request(ctx.app).get('/v1/admin/system-health').set(bearer(admin)).expect(200);
    const res = await request(ctx.app).get('/v1/admin/system-health/metrics?limit=5&thresholdMs=250').set(bearer(admin)).expect(200);
    expect(res.body.series.length).toBeLessThanOrEqual(5);
    expect(res.body.thresholdMs).toBe(250);
    expect(res.body.summary).toBeDefined();
    expect(res.body.alert).toBeDefined();
  });

  it('exports recent checks as CSV', async () => {
    const res = await request(ctx.app).get('/v1/admin/system-health/logs.csv').set(bearer(admin)).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.split('\n')[0]).toMatch(/[A-Za-z]/);
  });

  it('no longer serves a PDF (the dashboard renders it)', async () => {
    await request(ctx.app).get('/v1/admin/system-health/report.pdf').set(bearer(admin)).expect(404);
  });

  it('reports degraded when the database probe fails', async () => {
    const health = createSystemHealth(database.pool, { probe: async () => ({ connected: false, latencyMs: null, message: 'down' }) });
    const snapshot = await health.snapshot();
    expect(snapshot.overallStatus).toBe('degraded');
    expect(snapshot.database.status).toBe('disconnected');
  });
});
