/**
 * Redis-based Distributed Rate Limiter Service
 *
 * Uses fixed window algorithm with atomic Redis operations (Lua script).
 * Supports soft limit (immediate processing) and hard limit (delayed then rejected).
 * Implements dual-level rate limiting: company-level and user-level.
 */

import { env } from '../config/env.config';
import { getRedisConnection } from '../lib/redis';

/**
 * Rate limit check result
 */
export interface iRateLimitResult {
  /** Whether the request should be processed (false = hard limit exceeded) */
  allowed: boolean;
  /** Remaining requests before soft limit */
  remaining: number;
  /** Time until rate limit window resets (ms) */
  resetIn: number;
  /** Delay in milliseconds to apply to this request (0 if under soft limit) */
  delayMs: number;
  /** Which level triggered the limit (company or user) */
  limitedBy?: 'company' | 'user';
}

/**
 * Delay per request over the soft limit (5 seconds)
 */
const DELAY_PER_EXCESS_REQUEST_MS = 5000;

/**
 * Lua script for atomic rate limit check and increment
 *
 * KEYS[1] = rate limit key
 * ARGV[1] = window duration in ms
 *
 * Returns: [count, ttl]
 * - count: current request count after increment
 * - ttl: remaining time until key expires (ms), -1 if no expiry set
 */
const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])

local count = redis.call('INCR', key)
if count == 1 then
  redis.call('PEXPIRE', key, windowMs)
end
local ttl = redis.call('PTTL', key)

return {count, ttl}
`;

/**
 * Build Redis key for rate limiting
 */
function buildRateLimitKey(identifier: string): string {
  return `${env.REDIS_PREFIX}ratelimit:${identifier}`;
}

/**
 * Check single-level rate limit
 * Internal function used by both company and user level checks
 */
async function checkSingleRateLimit(
  key: string,
  softLimit: number,
  hardLimit: number,
  windowMs: number
): Promise<iRateLimitResult & { count: number }> {
  const redis = getRedisConnection();

  // Execute atomic Lua script
  const result = (await redis.eval(RATE_LIMIT_SCRIPT, 1, key, windowMs)) as [number, number];

  const [count, ttl] = result;
  const resetIn = ttl > 0 ? ttl : windowMs;
  const excessRequests = count - softLimit;

  // Under soft limit - no delay
  if (excessRequests <= 0) {
    return {
      allowed: true,
      remaining: softLimit - count,
      resetIn,
      delayMs: 0,
      count,
    };
  }

  // Calculate how many requests are over the soft limit toward hard limit
  const hardLimitExcess = hardLimit - softLimit;

  // Over hard limit - reject
  if (excessRequests > hardLimitExcess) {
    return {
      allowed: false,
      remaining: 0,
      resetIn,
      delayMs: 0,
      count,
    };
  }

  // Between soft and hard limit - calculate delay
  const delayMs = excessRequests * DELAY_PER_EXCESS_REQUEST_MS;

  return {
    allowed: true,
    remaining: 0,
    resetIn,
    delayMs,
    count,
  };
}

/**
 * Check rate limit for a given company and optional user
 *
 * Implements dual-level rate limiting:
 * - Company level: Aggregate limit for all users in a company
 * - User level: Individual limit per user (stricter, prevents single user abuse)
 *
 * Rate limit behavior:
 * - Under soft limit: immediate processing (delayMs = 0)
 * - Between soft and hard limit: accepted with delay (delayMs > 0)
 * - Over hard limit: rejected (allowed = false)
 *
 * @param companyId - Company identifier for rate limiting
 * @param userId - Optional user identifier for user-level rate limiting
 * @returns Rate limit result with allowed status and delay
 */
export async function checkRateLimit(
  companyId: string,
  userId?: string
): Promise<iRateLimitResult> {
  try {
    // Check company-level limit first
    const companyKey = buildRateLimitKey(`company:${companyId}`);
    const companyResult = await checkSingleRateLimit(
      companyKey,
      env.RATE_LIMIT_SOFT_MAX,
      env.RATE_LIMIT_HARD_MAX,
      env.RATE_LIMIT_WINDOW_MS
    );

    // If company limit exceeded, return immediately
    if (!companyResult.allowed) {
      return {
        allowed: false,
        remaining: 0,
        resetIn: companyResult.resetIn,
        delayMs: 0,
        limitedBy: 'company',
      };
    }

    // Check user-level limit if userId provided
    if (userId) {
      const userKey = buildRateLimitKey(`user:${companyId}:${userId}`);
      const userResult = await checkSingleRateLimit(
        userKey,
        env.RATE_LIMIT_USER_SOFT_MAX,
        env.RATE_LIMIT_USER_HARD_MAX,
        env.RATE_LIMIT_USER_WINDOW_MS
      );

      // If user limit exceeded, return user result
      if (!userResult.allowed) {
        return {
          allowed: false,
          remaining: 0,
          resetIn: userResult.resetIn,
          delayMs: 0,
          limitedBy: 'user',
        };
      }

      // Return the more restrictive result (higher delay or lower remaining)
      if (userResult.delayMs > companyResult.delayMs) {
        return {
          allowed: true,
          remaining: Math.min(companyResult.remaining, userResult.remaining),
          resetIn: Math.min(companyResult.resetIn, userResult.resetIn),
          delayMs: userResult.delayMs,
          limitedBy: 'user',
        };
      }
    }

    // Return company result
    return {
      allowed: companyResult.allowed,
      remaining: companyResult.remaining,
      resetIn: companyResult.resetIn,
      delayMs: companyResult.delayMs,
      limitedBy: companyResult.delayMs > 0 ? 'company' : undefined,
    };
  } catch (error) {
    // On Redis error, fail open (allow request) to prevent service disruption
    console.error('[RateLimiter] Redis error, failing open:', error);
    return {
      allowed: true,
      remaining: env.RATE_LIMIT_SOFT_MAX,
      resetIn: env.RATE_LIMIT_WINDOW_MS,
      delayMs: 0,
    };
  }
}

/**
 * Get current rate limit status without incrementing (for monitoring)
 *
 * @param identifier - Unique identifier for rate limiting
 * @returns Current count and TTL, or null if no limit exists
 */
export async function getRateLimitStatus(
  identifier: string
): Promise<{ count: number; resetIn: number } | null> {
  const redis = getRedisConnection();
  const key = buildRateLimitKey(identifier);

  try {
    const [countStr, ttl] = await Promise.all([redis.get(key), redis.pttl(key)]);

    if (countStr === null) {
      return null;
    }

    return {
      count: parseInt(countStr, 10),
      resetIn: ttl > 0 ? ttl : 0,
    };
  } catch (error) {
    console.error('[RateLimiter] Failed to get status:', error);
    return null;
  }
}
