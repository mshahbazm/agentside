/**
 * Environment configuration for the command service.
 *
 * Trimmed after the pi-mono port. Dead config from the old scout/worker
 * architecture (SCOUT_*, COMMAND_WORKER_*, CONVERSATION_*, COMMAND_JOB_*) was
 * removed — everything below is actively consumed somewhere in src/.
 */

import 'dotenv/config';

interface iEnvConfig {
  // Server
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';

  // MongoDB
  MONGODB_URI: string;

  // Redis
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD?: string;
  REDIS_USER: string;
  REDIS_TLS: boolean;
  REDIS_PREFIX: string;

  // ATS URLs
  PRIVATE_ATS_API_URL: string;
  ATS_FRONTEND_URL: string;
  ATS_ADMIN_URL: string;

  // Auth
  AUTH_SECRET: string;
  ATS_API_KEY: string;

  // LLM (pi-ai)
  /** Model selector in "provider/model-id" format, e.g. "digitalocean/alibaba-qwen3-32b". */
  LLM_MODEL: string;
  /** API key for the selected LLM provider. */
  LLM_KEY: string;

  // Rate limiting (company + user level)
  RATE_LIMIT_SOFT_MAX: number;
  RATE_LIMIT_HARD_MAX: number;
  RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_USER_SOFT_MAX: number;
  RATE_LIMIT_USER_HARD_MAX: number;
  RATE_LIMIT_USER_WINDOW_MS: number;

  // ATS-API request tuning (used by tools/shared/ats-client.ts)
  EXECUTOR_REQUEST_TIMEOUT_MS: number;
  EXECUTOR_MAX_RETRIES: number;

  /**
   * When true, `src/agent/event-logger.ts` emits one line per AgentEvent
   * (agent_start, tool_start, tool_end, message_end, ...) to stdout so we can
   * trace what the agent actually did in a given turn. Off by default — turn
   * on in dev via `VERBOSE_AGENT_LOG=true` in .env.
   */
  VERBOSE_AGENT_LOG: boolean;
}

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function getOptionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function getNumericEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, got: ${value}`);
  }
  return parsed;
}

function getBooleanEnv(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

function getNodeEnv(): 'development' | 'production' | 'test' {
  const value = process.env.NODE_ENV;
  const valid = ['development', 'production', 'test'] as const;
  if (!value) return 'development';
  if (!valid.includes(value as (typeof valid)[number])) {
    throw new Error(`NODE_ENV must be one of: ${valid.join(', ')}. Got: ${value}`);
  }
  return value as 'development' | 'production' | 'test';
}

export const env: iEnvConfig = {
  PORT: getNumericEnv('PORT', 3005),
  NODE_ENV: getNodeEnv(),

  MONGODB_URI: getRequiredEnv('MONGODB_URI'),

  REDIS_HOST: getOptionalEnv('REDIS_HOST', 'localhost'),
  REDIS_PORT: getNumericEnv('REDIS_PORT', 6379),
  REDIS_PASSWORD: process.env.REDIS_PASSWORD,
  REDIS_USER: getOptionalEnv('REDIS_USER', 'default'),
  REDIS_TLS: getBooleanEnv('REDIS_TLS', false),
  REDIS_PREFIX: getOptionalEnv('REDIS_PREFIX', 'cmd:'),

  PRIVATE_ATS_API_URL: getRequiredEnv('PRIVATE_ATS_API_URL'),
  ATS_FRONTEND_URL: getRequiredEnv('ATS_FRONTEND_URL'),
  ATS_ADMIN_URL: getRequiredEnv('ATS_ADMIN_URL'),

  AUTH_SECRET: getRequiredEnv('AUTH_SECRET'),
  ATS_API_KEY: getRequiredEnv('ATS_API_KEY'),

  LLM_MODEL: getRequiredEnv('LLM_MODEL'),
  LLM_KEY: getRequiredEnv('LLM_KEY'),

  RATE_LIMIT_SOFT_MAX: getNumericEnv('RATE_LIMIT_SOFT_MAX', 20),
  RATE_LIMIT_HARD_MAX: getNumericEnv('RATE_LIMIT_HARD_MAX', 50),
  RATE_LIMIT_WINDOW_MS: getNumericEnv('RATE_LIMIT_WINDOW_MS', 60_000),
  RATE_LIMIT_USER_SOFT_MAX: getNumericEnv('RATE_LIMIT_USER_SOFT_MAX', 10),
  RATE_LIMIT_USER_HARD_MAX: getNumericEnv('RATE_LIMIT_USER_HARD_MAX', 20),
  RATE_LIMIT_USER_WINDOW_MS: getNumericEnv('RATE_LIMIT_USER_WINDOW_MS', 60_000),

  EXECUTOR_REQUEST_TIMEOUT_MS: getNumericEnv('EXECUTOR_REQUEST_TIMEOUT_MS', 30_000),
  EXECUTOR_MAX_RETRIES: getNumericEnv('EXECUTOR_MAX_RETRIES', 3),

  VERBOSE_AGENT_LOG: getBooleanEnv('VERBOSE_AGENT_LOG', false),
};

if (env.NODE_ENV === 'development') {
  console.log('[env] ✅ command-service environment validated');
}
