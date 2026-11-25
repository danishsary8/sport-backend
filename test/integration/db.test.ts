import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { settings } from '../../src/db/schema/index.js';
import { TEST_DATABASE_URL } from '../helpers/testConfig.js';

let database: Database;

beforeAll(async () => {
  database = createDb({ databaseUrl: TEST_DATABASE_URL, databaseSsl: false });
  await runMigrations(database.db);
  await database.db.delete(settings);
});

afterAll(async () => {
  await database.close();
});

describe('database client', () => {
  it('pings a reachable database', async () => {
    await expect(database.ping()).resolves.toBeUndefined();
  });

  it('round-trips jsonb settings', async () => {
    await database.db.insert(settings).values({ key: 'khr_rate', value: { khr_rate: 4100 } });
    const [row] = await database.db.select().from(settings).where(eq(settings.key, 'khr_rate'));
    expect(row?.value).toEqual({ khr_rate: 4100 });
  });

  it('fails a ping to an unreachable database within 3.5s', async () => {
    const broken = createDb({ databaseUrl: 'postgres://postgres:postgres@127.0.0.1:1/none', databaseSsl: false });
    const started = Date.now();
    await expect(broken.ping()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3500);
    await broken.close();
  }, 6000);
});

describe('pool recovery', () => {
  it('frees connections stuck on slow queries so the database becomes ready again', async () => {
    const small = createDb({ databaseUrl: TEST_DATABASE_URL, databaseSsl: false }, () => {}, {
      queryTimeoutMs: 1000,
      maxConnections: 3,
    });
    // Occupy every connection with a query that would run for 30s.
    const stuck = Array.from({ length: 3 }, () => small.pool.query('select pg_sleep(30)').catch(() => 'timed out'));
    const started = Date.now();
    // The ping has to wait for a free connection; it succeeds once the stuck queries time out.
    await expect(small.ping()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await Promise.all(stuck)).toEqual(['timed out', 'timed out', 'timed out']);
    await small.close();
  }, 10_000);
});
