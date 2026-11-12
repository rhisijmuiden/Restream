import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function migrationsDir() {
  const candidates = [path.join(here, 'migrations'), path.join(here, '..', 'migrations')];
  const dir = candidates.find((d) => existsSync(d));
  if (!dir) throw new Error('migrations directory not found');
  return dir;
}

/** Names of the migrations this version of Restream knows. */
export function migrationFiles(): string[] {
  return readdirSync(migrationsDir()).filter((f) => f.endsWith('.sql')).sort();
}

/** Applies pending SQL migrations in filename order, each in its own transaction. */
export async function migrate(sql: Sql, log: (msg: string) => void = () => {}) {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const done = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const body = readFileSync(path.join(dir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    log(`applied migration ${file}`);
  }
}
