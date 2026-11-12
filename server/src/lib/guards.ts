import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from './session.js';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

const rank: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

/** Requires a fully authenticated session (password + 2FA). */
export function requireAuth(minRole: Role = 'viewer', opts: { allowPasswordChange?: boolean } = {}) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.user || !req.session || req.session.stage !== 'full') throw new HttpError(401, 'unauthenticated');
    if (req.user.must_change_password && !opts.allowPasswordChange) throw new HttpError(403, 'password_change_required');
    if (rank[req.user.role] < rank[minRole]) throw new HttpError(403, 'forbidden');
  };
}
