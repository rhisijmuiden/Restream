import { config } from './config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';
import { buildApp } from './app.js';

const sql = createDb();
await migrate(sql, (m) => console.log(m));
const app = await buildApp(sql);

// Expired sessions are cleaned up hourly.
setInterval(() => { sql`DELETE FROM sessions WHERE expires_at < now()`.catch(() => {}); }, 3600_000).unref();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  });
}

await app.listen({ host: config.host, port: config.port });
