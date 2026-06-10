/**
 * Auth token payload.
 *
 * The JWT your frontend presents at WebSocket upgrade. Adjust the optional
 * claims to match your token. The agent backend only relies on `sub` (user id) and
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
