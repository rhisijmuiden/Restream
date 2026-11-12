import { hash, verify } from '@node-rs/argon2';

// Argon2id with OWASP recommended parameters.
const opts = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (pw: string) => hash(pw, opts);
export const verifyPassword = async (hashStr: string, pw: string) => {
  try { return await verify(hashStr, pw); } catch { return false; }
};

/** Minimal policy: 12+ characters. Length beats complexity rules. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 12) return 'password_too_short';
  if (pw.length > 256) return 'password_too_long';
  return null;
}
