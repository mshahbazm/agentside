/**
 * Environment configuration for agentside.
 *
 * Every variable below is actively consumed somewhere in src/. When adding a
 * new variable, document it in .env.example and the README env table.
 */

import 'dotenv/config';

interface iEnvConfig {
  // Server
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';

  // App identity (used in the system prompt)
  APP_NAME: string;

  // MongoDB
  MONGODB_URI: string;

  // Redis
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD?: string;
  REDIS_USER: string;
  REDIS_TLS: boolean;
  REDIS_PREFIX: string;

  // Your app's API — the backend the agent calls tools against
  APP_API_URL: string;
  /** Service key sent as x-internal-key on every tool request. */
  APP_API_KEY: string;

  /** Comma-separated list of allowed CORS origins (your frontend URLs). */
  CORS_ORIGINS: string[];

  // Auth
  /** Secret used to verify the JWT the frontend presents at WS upgrade. */
  AUTH_SECRET: string;

  // LLM (pi-ai)
  /** Model selector in "provider/model-id" format, e.g. "anthropic/claude-sonnet-4-6". */
  LLM_MODEL: string;
  /** API key for the selected LLM provider. */
  LLM_KEY: string;

  // Rate limiting (tenant + user level)
  RATE_LIMIT_SOFT_MAX: number;
  RATE_LIMIT_HARD_MAX: number;
  RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_USER_SOFT_MAX: number;
  RATE_LIMIT_USER_HARD_MAX: number;
  RATE_LIMIT_USER_WINDOW_MS: number;

  // App-API request tuning (used by tools/shared/api-client.ts)
  API_REQUEST_TIMEOUT_MS: number;
  API_MAX_RETRIES: number;

  /**
   * When true, `src/agent/event-logger.ts` emits one line per AgentEvent
   * (agent_start, tool_start, tool_end, message_end, ...) to stdout so you can
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

function getCorsOrigins(): string[] {
  const raw = getRequiredEnv('CORS_ORIGINS');
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    throw new Error('CORS_ORIGINS must contain at least one origin (comma-separated).');
  }
  return origins;
}

export const env: iEnvConfig = {
  PORT: getNumericEnv('PORT', 3005),
  NODE_ENV: getNodeEnv(),

  APP_NAME: getOptionalEnv('APP_NAME', 'this application'),

  MONGODB_URI: getRequiredEnv('MONGODB_URI'),

  REDIS_HOST: getOptionalEnv('REDIS_HOST', 'localhost'),
  REDIS_PORT: getNumericEnv('REDIS_PORT', 6379),
  REDIS_PASSWORD: process.env.REDIS_PASSWORD,
  REDIS_USER: getOptionalEnv('REDIS_USER', 'default'),
  REDIS_TLS: getBooleanEnv('REDIS_TLS', false),
  REDIS_PREFIX: getOptionalEnv('REDIS_PREFIX', 'agentside:'),

  APP_API_URL: getRequiredEnv('APP_API_URL'),
  APP_API_KEY: getRequiredEnv('APP_API_KEY'),

  CORS_ORIGINS: getCorsOrigins(),

  AUTH_SECRET: getRequiredEnv('AUTH_SECRET'),

  LLM_MODEL: getRequiredEnv('LLM_MODEL'),
  LLM_KEY: getRequiredEnv('LLM_KEY'),

  RATE_LIMIT_SOFT_MAX: getNumericEnv('RATE_LIMIT_SOFT_MAX', 20),
  RATE_LIMIT_HARD_MAX: getNumericEnv('RATE_LIMIT_HARD_MAX', 50),
  RATE_LIMIT_WINDOW_MS: getNumericEnv('RATE_LIMIT_WINDOW_MS', 60_000),
  RATE_LIMIT_USER_SOFT_MAX: getNumericEnv('RATE_LIMIT_USER_SOFT_MAX', 10),
  RATE_LIMIT_USER_HARD_MAX: getNumericEnv('RATE_LIMIT_USER_HARD_MAX', 20),
  RATE_LIMIT_USER_WINDOW_MS: getNumericEnv('RATE_LIMIT_USER_WINDOW_MS', 60_000),

  API_REQUEST_TIMEOUT_MS: getNumericEnv('API_REQUEST_TIMEOUT_MS', 30_000),
  API_MAX_RETRIES: getNumericEnv('API_MAX_RETRIES', 3),

  VERBOSE_AGENT_LOG: getBooleanEnv('VERBOSE_AGENT_LOG', false),
};

if (env.NODE_ENV === 'development') {
  console.log('[env] ✅ agentside environment validated');
}
