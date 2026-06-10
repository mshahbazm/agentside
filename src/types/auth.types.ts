/**
 * Auth token payload.
 *
 * Inlined from the host app's JWT contract when agentside was extracted from
 * the Cuee monorepo. The agent backend only relies on `sub` (user id) and
 * `companyId` (tenant); everything else is passed through untouched.
 */

export interface iJwtPayload {
  sub: string; // User ID
  jti: string; // JWT ID (session token)
  exp: number; // Expiration timestamp
  iat: number; // Issued at timestamp
  kid: string; // Key ID - environment variable name

  // Tenant / member context
  companyId?: string;
  teamMemberId?: string;

  // System user flag
  isSystemUser?: boolean;

  // Token purpose
  purpose?: string;
}
