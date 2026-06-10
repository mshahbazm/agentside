/**
 * Redis Connection
 * Standalone Redis connection management for services that need Redis (e.g., rate limiter)
 */

import { Redis } from 'ioredis';
import { env } from '../config/env.config';

let redisConnection: Redis | null = null;

/**
 * Get or create Redis connection
 */
export function getRedisConnection(): Redis {
  if (!redisConnection) {
    redisConnection = new Redis({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD || undefined,
      username: env.REDIS_USER,
      tls: env.REDIS_TLS ? {} : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      enableOfflineQueue: true,
      connectTimeout: 10000,
      keepAlive: 10000,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 30000);
        console.log(`[Redis] Reconnecting in ${delay}ms (attempt ${times})`);
        return delay;
      },
    });

    redisConnection.on('error', (err) => {
      console.error('[Redis] Connection error:', err);
      if (redisConnection) {
        redisConnection.quit().catch((quitErr) => {
          console.error('[Redis] Error closing connection:', quitErr);
        });
        redisConnection = null;
      }
    });

    redisConnection.on('connect', () => {
      console.log('[Redis] Connected');
    });

    redisConnection.on('reconnecting', () => {
      console.log('[Redis] Reconnecting...');
    });

    redisConnection.on('ready', () => {
      console.log('[Redis] Connection ready');
    });
  }

  return redisConnection;
}

/**
 * Gracefully close Redis connection
 */
export async function closeRedisConnection(): Promise<void> {
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
    console.log('[Redis] Connection closed');
  }
}
