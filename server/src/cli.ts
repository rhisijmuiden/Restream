/**
 * restream-cli: server maintenance from the shell.
 *   create-admin --email <e> [--password <p>] [--name <n>] [--if-none]
 *   reset-password --email <e>
 *   reset-2fa --email <e>
 *   migrate
 */
import { parseArgs } from 'node:util';
import { createDb } from './db.js';
import { migrate } from './migrate.js';
import { generatePassword } from './lib/crypto.js';
import { hashPassword, passwordProblem } from './lib/password.js';

const [cmd, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' }, 'if-none': { type: 'boolean' } },
});
const sql = createDb();

function need(v: string | undefined, flag: string): string {
  if (!v) { console.error(`--${flag} is required`); process.exit(2); }
  return v;
}

try {
  await migrate(sql);
  switch (cmd) {
    case 'migrate':
      console.log('database is up to date');
      break;
    case 'create-admin': {
      const email = need(values.email, 'email');
      if (values['if-none']) {
        const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`;
        if (n > 0) { console.log('an administrator already exists; nothing to do'); break; }
      }
      const password = values.password || generatePassword();
      const problem = passwordProblem(password);
      if (problem) throw new Error(problem);
      const hash = await hashPassword(password);
      await sql`
        INSERT INTO users (email, name, role, password_hash, must_change_password)
        VALUES (${email}, ${values.name ?? 'Administrator'}, 'admin', ${hash}, ${!values.password})
        ON CONFLICT (lower(email)) DO UPDATE SET role = 'admin', password_hash = EXCLUDED.password_hash,
          must_change_password = EXCLUDED.must_change_password, disabled = false, failed_logins = 0, locked_until = NULL`;
      console.log(`admin: ${email}\npassword: ${password}`);
      break;
    }
    case 'reset-password': {
      const email = need(values.email, 'email');
      const password = generatePassword();
      const r = await sql`
        UPDATE users SET password_hash = ${await hashPassword(password)}, must_change_password = true,
               failed_logins = 0, locked_until = NULL, disabled = false
        WHERE lower(email) = lower(${email})`;
      if (!r.count) throw new Error('user not found');
      console.log(`temporary password: ${password}`);
      break;
    }
    case 'reset-2fa': {
      const email = need(values.email, 'email');
      const r = await sql`
        UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL, recovery_codes = '[]'::jsonb
        WHERE lower(email) = lower(${email})`;
      if (!r.count) throw new Error('user not found');
      await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE lower(email) = lower(${email}))`;
      console.log('2FA reset; the user sets it up again at the next sign-in');
      break;
    }
    default:
      console.log('usage: restream-cli <create-admin|reset-password|reset-2fa|migrate> [--email ...] [--password ...]');
      process.exitCode = cmd ? 2 : 0;
  }
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
