import pg from "pg";

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

// Return bigint columns (amounts in cents) as JS numbers; amounts are capped far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
// Keep DATE columns as 'YYYY-MM-DD' strings instead of local-time Date objects.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export function createPool(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000 });
  pool.on("error", (error) => {
    // Idle client errors (e.g. the server restarted); the pool replaces the client.
    console.error("PostgreSQL pool error:", error.message);
  });
  return pool;
}

/** Fails fast when the database is unreachable; there is no in-memory fallback. */
export async function assertDatabaseReachable(db: Db): Promise<void> {
  await db.query("SELECT 1");
}

/** Runs fn inside a transaction, committing on success and rolling back on any error. */
export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
