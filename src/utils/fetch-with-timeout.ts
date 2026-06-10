/**
 * Fetch with timeout utility
 * Wraps fetch calls with AbortController to prevent hanging requests
 */

import { env } from '../config/env.config';

/**
 * Default timeout from env or 30 seconds
 */
const DEFAULT_TIMEOUT_MS = env.EXECUTOR_REQUEST_TIMEOUT_MS || 30000;

/**
 * Fetch with automatic timeout
 * Prevents hanging requests by aborting after specified duration
 *
 * @param url - URL to fetch
 * @param options - Standard fetch options
 * @param timeoutMs - Timeout in milliseconds (default: EXECUTOR_REQUEST_TIMEOUT_MS or 30s)
 * @returns Promise<Response>
 * @throws Error with 'Request timed out' message if timeout exceeded
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch JSON with timeout
 * Convenience wrapper that parses JSON response
 *
 * @param url - URL to fetch
 * @param options - Standard fetch options
 * @param timeoutMs - Timeout in milliseconds
 * @returns Promise<T> - Parsed JSON response
 */
export async function fetchJsonWithTimeout<T = unknown>(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<{ ok: boolean; status: number; data: T }> {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const data = await response.json() as T;
  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}
