/**
 * Analytics Service
 * Lightweight tool usage analytics for optimization insights
 * Uses Redis for storage with automatic expiration
 */

import { getRedisConnection } from '../lib/redis';
import { env } from '../config/env.config';
import { loggers } from '../utils';

const log = loggers.ai || console;

/**
 * Redis key prefix for analytics
 */
const ANALYTICS_KEY_PREFIX = `${env.REDIS_PREFIX}analytics:`;

/**
 * Default retention period in hours (7 days)
 */
const DEFAULT_RETENTION_HOURS = 24 * 7;

/**
 * Tool usage event
 */
export interface iToolUsageEvent {
  toolName: string;
  companyId: string;
  success: boolean;
  durationMs: number;
  timestamp?: Date;
}

/**
 * Tool statistics
 */
export interface iToolStats {
  toolName: string;
  total: number;
  success: number;
  failure: number;
  avgDurationMs: number;
  successRate: number;
}

/**
 * Get the current hour bucket key (for hourly aggregation)
 */
function getHourBucket(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  return `${year}${month}${day}${hour}`;
}

/**
 * Record a tool usage event
 * Fire-and-forget - errors are logged but don't affect the caller
 *
 * @param event - Tool usage event to record
 */
export async function recordToolUsage(event: iToolUsageEvent): Promise<void> {
  try {
    const redis = getRedisConnection();
    const hourBucket = getHourBucket(event.timestamp || new Date());
    const toolKey = `${ANALYTICS_KEY_PREFIX}tool:${event.toolName}:${hourBucket}`;
    const companyKey = `${ANALYTICS_KEY_PREFIX}company:${event.companyId}:${hourBucket}`;

    // Use pipeline for atomic operations
    const pipeline = redis.pipeline();

    // Tool-level metrics
    pipeline.hincrby(toolKey, 'total', 1);
    pipeline.hincrby(toolKey, event.success ? 'success' : 'failure', 1);
    pipeline.hincrby(toolKey, 'duration_ms', event.durationMs);
    pipeline.expire(toolKey, DEFAULT_RETENTION_HOURS * 3600);

    // Company-level metrics
    pipeline.hincrby(companyKey, 'total', 1);
    pipeline.hincrby(companyKey, event.success ? 'success' : 'failure', 1);
    pipeline.expire(companyKey, DEFAULT_RETENTION_HOURS * 3600);

    await pipeline.exec();
  } catch (error) {
    // Non-critical - log and continue
    log.warn?.('Failed to record tool usage analytics', {
      toolName: event.toolName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get tool statistics for a given time range
 *
 * @param toolName - Tool name to get stats for
 * @param hours - Number of hours to look back (default: 24)
 * @returns Tool statistics or null if no data
 */
export async function getToolStats(
  toolName: string,
  hours: number = 24
): Promise<iToolStats | null> {
  try {
    const redis = getRedisConnection();
    const now = new Date();

    // Generate keys for each hour bucket
    const keys: string[] = [];
    for (let i = 0; i < hours; i++) {
      const bucketDate = new Date(now.getTime() - i * 60 * 60 * 1000);
      const bucket = getHourBucket(bucketDate);
      keys.push(`${ANALYTICS_KEY_PREFIX}tool:${toolName}:${bucket}`);
    }

    // Fetch all buckets
    const pipeline = redis.pipeline();
    for (const key of keys) {
      pipeline.hgetall(key);
    }

    const results = await pipeline.exec();

    // Aggregate results
    let total = 0;
    let success = 0;
    let failure = 0;
    let totalDuration = 0;

    for (const [err, result] of results || []) {
      if (err || !result) continue;
      const data = result as Record<string, string>;

      total += parseInt(data.total || '0', 10);
      success += parseInt(data.success || '0', 10);
      failure += parseInt(data.failure || '0', 10);
      totalDuration += parseInt(data.duration_ms || '0', 10);
    }

    if (total === 0) {
      return null;
    }

    return {
      toolName,
      total,
      success,
      failure,
      avgDurationMs: Math.round(totalDuration / total),
      successRate: total > 0 ? Math.round((success / total) * 100) / 100 : 0,
    };
  } catch (error) {
    log.warn?.('Failed to get tool stats', {
      toolName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Get company usage statistics
 *
 * @param companyId - Company ID to get stats for
 * @param hours - Number of hours to look back (default: 24)
 * @returns Usage statistics or null if no data
 */
export async function getCompanyUsageStats(
  companyId: string,
  hours: number = 24
): Promise<{ total: number; success: number; failure: number; successRate: number } | null> {
  try {
    const redis = getRedisConnection();
    const now = new Date();

    // Generate keys for each hour bucket
    const keys: string[] = [];
    for (let i = 0; i < hours; i++) {
      const bucketDate = new Date(now.getTime() - i * 60 * 60 * 1000);
      const bucket = getHourBucket(bucketDate);
      keys.push(`${ANALYTICS_KEY_PREFIX}company:${companyId}:${bucket}`);
    }

    // Fetch all buckets
    const pipeline = redis.pipeline();
    for (const key of keys) {
      pipeline.hgetall(key);
    }

    const results = await pipeline.exec();

    // Aggregate results
    let total = 0;
    let success = 0;
    let failure = 0;

    for (const [err, result] of results || []) {
      if (err || !result) continue;
      const data = result as Record<string, string>;

      total += parseInt(data.total || '0', 10);
      success += parseInt(data.success || '0', 10);
      failure += parseInt(data.failure || '0', 10);
    }

    if (total === 0) {
      return null;
    }

    return {
      total,
      success,
      failure,
      successRate: total > 0 ? Math.round((success / total) * 100) / 100 : 0,
    };
  } catch (error) {
    log.warn?.('Failed to get company usage stats', {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Get top tools by usage
 *
 * @param limit - Number of top tools to return (default: 10)
 * @param hours - Number of hours to look back (default: 24)
 * @returns Array of tool stats sorted by total usage
 */
export async function getTopTools(
  limit: number = 10,
  hours: number = 24
): Promise<iToolStats[]> {
  try {
    const redis = getRedisConnection();
    const now = new Date();

    // Get all tool keys for the time range
    const pattern = `${ANALYTICS_KEY_PREFIX}tool:*`;
    const keys = await redis.keys(pattern);

    // Extract unique tool names
    const toolNames = new Set<string>();
    const hourBuckets = new Set<string>();

    for (let i = 0; i < hours; i++) {
      const bucketDate = new Date(now.getTime() - i * 60 * 60 * 1000);
      hourBuckets.add(getHourBucket(bucketDate));
    }

    for (const key of keys) {
      // Key format: {prefix}analytics:tool:{toolName}:{hourBucket}
      const parts = key.replace(ANALYTICS_KEY_PREFIX, '').split(':');
      if (parts.length >= 3 && parts[0] === 'tool') {
        const bucket = parts[parts.length - 1];
        if (hourBuckets.has(bucket)) {
          toolNames.add(parts[1]);
        }
      }
    }

    // Get stats for each tool
    const statsPromises = Array.from(toolNames).map((name) =>
      getToolStats(name, hours)
    );

    const allStats = await Promise.all(statsPromises);

    // Filter nulls and sort by total
    return allStats
      .filter((s): s is iToolStats => s !== null)
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);
  } catch (error) {
    log.warn?.('Failed to get top tools', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
