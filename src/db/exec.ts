import type { Db } from './client.js';

/** A Drizzle transaction handle. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that can run queries: the pool-backed db or a transaction. */
export type Exec = Db | Tx;
