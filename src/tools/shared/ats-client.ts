/**
 * AtsClient — typed HTTP client for ats-api used inside agent tools.
 *
 * Per-request instance (constructed inside buildAgent with the service
 * API key, acting user ID, and companyId). Returns parsed JSON directly or
 * throws `AtsApiError` on non-2xx, so tool `execute` functions can rely on
 * `throw` for error propagation (pi-agent-core catches and surfaces as
 * `isError: true` tool results).
 *
 * Protection: wraps the existing atsApi circuit breaker from services/.
 */

import { env } from '../../config/env.config';
import { atsApiCircuitBreaker, CircuitOpenError } from '../../services/circuit-breaker.service';

// ============================================================================
// Internal fetch wrapper (replaces the deleted executor/api-client.apiRequest)
// ============================================================================

type tHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface iApiRequestOptions {
  method: tHttpMethod;
  path: string;
  body?: unknown;
  apiKey: string;
  actAsUserId: string;
  query?: Record<string, string>;
  requestId?: string;
  signal?: AbortSignal;
}

interface iApiResponse<T = unknown> {
  success: boolean;
  status: number;
  data?: T;
  /**
   * Always a string by the time it leaves `singleRequest` — non-string ats-api
   * error payloads (objects, arrays, validation lists) are flattened by
   * `coerceErrorMessage` so consumers don't have to think about it.
   */
  error?: string;
  retryable?: boolean;
}

/**
 * Convert any value ats-api might return on the `error` slot of a failure
 * envelope into a single human-readable string. Handles strings, numbers,
 * Errors, validation arrays, and the common `{message}` / `{field, message}`
 * shapes. Falls back to `JSON.stringify` for unrecognised objects so the LLM
 * always sees something parseable instead of `[object Object]`.
 */
function coerceErrorMessage(value: unknown, fallback: string): string {
  if (value == null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) return value.message || fallback;

  // Validation arrays — e.g. [{ path: "content", message: "Required" }, ...]
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => coerceErrorMessage(item, ''))
      .filter((s) => s.length > 0);
    return parts.length > 0 ? parts.join('; ') : fallback;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Common ats-api error shapes
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.error === 'string') return obj.error;
    if (typeof obj.detail === 'string') return obj.detail;
    // Field-level validation: { field, message }
    if (typeof obj.field === 'string' && typeof obj.message === 'string') {
      return `${obj.field}: ${obj.message}`;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }

  return fallback;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

function buildUrl(path: string, query?: Record<string, string>): string {
  const baseUrl = env.PRIVATE_ATS_API_URL.replace(/\/$/, '');
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.append(k, v);
    }
  }
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt + Math.random() * 500, 30_000);
}

async function singleRequest<T>(opts: iApiRequestOptions): Promise<iApiResponse<T>> {
  const url = buildUrl(opts.path, opts.query);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Request-Source': 'command-service',
    'x-internal-key': opts.apiKey,
    'X-Act-As-User-Id': opts.actAsUserId,
  };
  if (opts.requestId) headers['X-Request-ID'] = opts.requestId;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), env.EXECUTOR_REQUEST_TIMEOUT_MS);
  const signal = opts.signal ?? controller.signal;

  try {
    const response = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal,
    });
    let data: T | undefined;
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      try {
        data = (await response.json()) as T;
      } catch {
        /* non-json response body */
      }
    }
    if (!response.ok) {
      const retryable = isRetryableStatus(response.status);
      const errMessage = coerceErrorMessage(
        (data as { error?: unknown } | undefined)?.error,
        `HTTP ${response.status}`,
      );
      return { success: false, status: response.status, error: errMessage, data, retryable };
    }
    return { success: true, status: response.status, data };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        success: false,
        status: 408,
        error: 'The server took too long to respond',
        retryable: true,
      };
    }
    return {
      success: false,
      status: 500,
      error: err instanceof Error ? err.message : 'Network error',
      retryable: true,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function apiRequest<T = unknown>(opts: iApiRequestOptions): Promise<iApiResponse<T>> {
  const exec = async (): Promise<iApiResponse<T>> => {
    const maxRetries = env.EXECUTOR_MAX_RETRIES;
    let last: iApiResponse<T> | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      last = await singleRequest<T>(opts);
      if (last.success) return last;
      if (!last.retryable || attempt === maxRetries) return last;
      await sleep(backoff(attempt));
    }
    return last!;
  };
  try {
    return await atsApiCircuitBreaker.execute(exec);
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      return {
        success: false,
        status: 503,
        error: 'Service temporarily unavailable. Please retry in a moment.',
        retryable: true,
      };
    }
    throw err;
  }
}

export interface iAtsClientOptions {
  /** Internal API key for service-to-service auth */
  apiKey: string;
  /** User ID to act as (from verified JWT) */
  actAsUserId: string;
  /** Company ID for path templating (:companyId) */
  companyId: string;
  /** Optional request ID for tracing */
  requestId?: string;
}

export class AtsApiError extends Error {
  public readonly status: number;
  public readonly retryable: boolean;

  constructor(message: string, status: number, retryable = false) {
    super(message);
    this.name = 'AtsApiError';
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Small substitute for the current executor — exposes one method per HTTP
 * verb, returns parsed JSON on success, throws AtsApiError on failure.
 */
export class AtsClient {
  public readonly companyId: string;
  private readonly apiKey: string;
  private readonly actAsUserId: string;
  private readonly requestId?: string;

  constructor(opts: iAtsClientOptions) {
    this.companyId = opts.companyId;
    this.apiKey = opts.apiKey;
    this.actAsUserId = opts.actAsUserId;
    this.requestId = opts.requestId;
  }

  /**
   * Substitute `:param` placeholders in a path template with values from an
   * args object. Consumed placeholders are removed from the returned "remaining"
   * object so the caller can attach the rest as body or query params.
   *
   *   fillPath('/companies/:companyId/jobs/:code', { code: 5, title: 'X' })
   *   → { path: '/companies/123/jobs/5', remaining: { title: 'X' } }
   */
  fillPath(
    template: string,
    args: Record<string, unknown>,
  ): { path: string; remaining: Record<string, unknown> } {
    const remaining: Record<string, unknown> = { ...args };
    const path = template.replace(/:([a-zA-Z][a-zA-Z0-9]*)/g, (_match, key: string) => {
      if (key === 'companyId') return this.companyId;
      if (key in remaining) {
        const value = remaining[key];
        delete remaining[key];
        return String(value);
      }
      throw new AtsApiError(
        `Missing path parameter "${key}" for ${template}`,
        400,
        false,
      );
    });
    return { path, remaining };
  }

  async get<T = unknown>(
    path: string,
    query?: Record<string, unknown>,
  ): Promise<T> {
    const queryStrings: Record<string, string> = {};
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        queryStrings[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
    }
    const res = await apiRequest<{ data?: T } & T>({
      method: 'GET',
      path,
      apiKey: this.apiKey,
      actAsUserId: this.actAsUserId,
      query: queryStrings,
      requestId: this.requestId,
    });
    return this.unwrap<T>(res);
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await apiRequest<{ data?: T } & T>({
      method: 'POST',
      path,
      body,
      apiKey: this.apiKey,
      actAsUserId: this.actAsUserId,
      requestId: this.requestId,
    });
    return this.unwrap<T>(res);
  }

  async put<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await apiRequest<{ data?: T } & T>({
      method: 'PUT',
      path,
      body,
      apiKey: this.apiKey,
      actAsUserId: this.actAsUserId,
      requestId: this.requestId,
    });
    return this.unwrap<T>(res);
  }

  async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await apiRequest<{ data?: T } & T>({
      method: 'PATCH',
      path,
      body,
      apiKey: this.apiKey,
      actAsUserId: this.actAsUserId,
      requestId: this.requestId,
    });
    return this.unwrap<T>(res);
  }

  async delete<T = unknown>(path: string): Promise<T> {
    const res = await apiRequest<{ data?: T } & T>({
      method: 'DELETE',
      path,
      apiKey: this.apiKey,
      actAsUserId: this.actAsUserId,
      requestId: this.requestId,
    });
    return this.unwrap<T>(res);
  }

  private unwrap<T>(res: { success: boolean; status: number; data?: unknown; error?: string; retryable?: boolean }): T {
    // Layer 1: HTTP status check (surfaced by singleRequest).
    if (!res.success) {
      throw new AtsApiError(
        coerceErrorMessage(res.error, `ATS API request failed with status ${res.status}`),
        res.status,
        res.retryable ?? false,
      );
    }

    // Layer 2: ats-api's application-level envelope. Some endpoints return
    // HTTP 200 with `{success: false, error, messageCode}` when e.g. a soft
    // validation fails. Without this check, the tool would hallucinate
    // success and the LLM would tell the user "Created job" when nothing
    // actually got created.
    const body = res.data as
      | { success?: boolean; error?: unknown; messageCode?: string; data?: unknown }
      | undefined;

    if (body && typeof body === 'object' && body.success === false) {
      throw new AtsApiError(
        coerceErrorMessage(
          body.error,
          `ATS API reported failure (${body.messageCode ?? 'unknown'})`,
        ),
        res.status,
        false,
      );
    }

    // Layer 3: unwrap the { data: ... } wrapper if present, otherwise return
    // the raw body.
    if (body && typeof body === 'object' && 'data' in body) {
      return body.data as T;
    }
    return res.data as T;
  }
}
