import type { FastifyRequest } from 'fastify';
import type { Sql } from '../db.js';

export async function audit(sql: Sql, req: FastifyRequest | null, action: string, details: Record<string, unknown> = {}, userId?: string | null) {
  await sql`
    INSERT INTO audit_log (user_id, action, details, ip)
    VALUES (${userId ?? req?.user?.id ?? null}, ${action}, ${sql.json((req?.apiKey ? { ...details, apiKey: req.apiKey.name } : details) as never)}, ${req?.ip ?? null})`;
}
