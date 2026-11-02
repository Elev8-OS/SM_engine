import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

let pool;

export function dbEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

export function db() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
    });
  }
  return pool;
}

export async function q(text, params = []) {
  const res = await db().query(text, params);
  return res.rows;
}

export async function migrate() {
  const sql = await fs.readFile(path.resolve('db/schema.sql'), 'utf8');
  await db().query(sql);
}
