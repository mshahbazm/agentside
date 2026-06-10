/**
 * JWT Authentication Utilities
 * Soft authentication for command-service
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
    return jwt.verify(token, env.AUTH_SECRET) as iJwtPayload;
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
