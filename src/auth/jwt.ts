/**
 * JWT Authentication Utilities
 * Soft authentication for agentside
 */

import jwt from 'jsonwebtoken';
import { env } from '../config/env.config';
import type { iJwtPayload } from '../types/auth.types';

const AUTH_COOKIE_NAME = 'auth-token';

/**
 * Extract auth token from cookie header
 */
export function extractAuthToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').map((c) => c.trim());
  const authCookie = cookies.find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));

  if (!authCookie) return null;

  return authCookie.substring(AUTH_COOKIE_NAME.length + 1);
}

/**
 * Verify JWT token
 * Returns decoded payload if valid, null if invalid
 */
export function verifyToken(token: string): iJwtPayload | null {
  try {
    // Pin the algorithm to HS256 (symmetric, AUTH_SECRET). Without this,
    // jsonwebtoken honors whatever `alg` the token header claims, which opens
    // algorithm-confusion attacks. If your tokens are RS256/ES256, change this
    // to the matching algorithm and a public key.
    const payload = jwt.verify(token, env.AUTH_SECRET, {
      algorithms: ['HS256'],
    }) as iJwtPayload;

    // Only full session tokens may drive the agent. If your auth issues other
    // token kinds with the SAME secret (refresh tokens, email/portal links,
    // password-reset tokens), they must NOT be accepted here — reject anything
    // carrying a non-session `purpose`. Adjust the allowed set to your scheme.
    if (payload.purpose && payload.purpose !== 'session') {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Extract and verify auth token from cookie header
 * Convenience function combining extract + verify
 */
export function authenticateFromCookie(cookieHeader: string | undefined): iJwtPayload | null {
  const token = extractAuthToken(cookieHeader);
  if (!token) return null;

  return verifyToken(token);
}

/**
 * Auth verification result
 */
interface iAuthResult {
  valid: boolean;
  payload?: {
    companyId: string;
    userId: string;
  };
}

/**
 * Verify authentication from either Authorization header or Cookie header
 * Used by route middleware
 */
export function verifyAuth(authOrCookie: string): iAuthResult {
  // Try as Bearer token first (Authorization header)
  if (authOrCookie.startsWith('Bearer ')) {
    const token = authOrCookie.substring(7);
    const payload = verifyToken(token);
    if (payload && payload.companyId) {
      return {
        valid: true,
        payload: {
          companyId: payload.companyId,
          userId: payload.sub, // User ID is stored in 'sub' field
        },
      };
    }
    return { valid: false };
  }

  // Try as cookie
  const payload = authenticateFromCookie(authOrCookie);
  if (payload && payload.companyId) {
    return {
      valid: true,
      payload: {
        companyId: payload.companyId,
        userId: payload.sub, // User ID is stored in 'sub' field
      },
    };
  }

  return { valid: false };
}
