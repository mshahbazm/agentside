/**
 * Circuit Breaker Service
 *
 * Implements the circuit breaker pattern to prevent cascading failures
 * when downstream services (like ats-api) are unavailable.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is down, requests fail fast
 * - HALF_OPEN: Testing if service recovered, limited requests pass through
 */

import { loggers } from '../utils';

const log = loggers.apiClient || console;

/**
 * Circuit breaker states
 */
export type tCircuitBreakerState = 'closed' | 'open' | 'half-open';

/**
 * Circuit breaker configuration
 */
export interface iCircuitBreakerConfig {
  /** Number of failures before opening circuit (default: 5) */
  failureThreshold: number;
  /** Time in ms before attempting to close circuit (default: 30000) */
  resetTimeout: number;
  /** Number of successful requests to close circuit in half-open state (default: 2) */
  successThreshold: number;
  /** Name for logging purposes */
  name: string;
}

/**
 * Internal circuit breaker state
 */
interface iCircuitBreakerInternalState {
  failures: number;
  successes: number;
  lastFailure: Date | null;
  state: tCircuitBreakerState;
}

/**
 * Error thrown when circuit is open
 */
export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Circuit Breaker class
 */
export class CircuitBreaker {
  private state: iCircuitBreakerInternalState;
  private config: iCircuitBreakerConfig;

  constructor(config: Partial<iCircuitBreakerConfig> & { name: string }) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      resetTimeout: config.resetTimeout ?? 30000,
      successThreshold: config.successThreshold ?? 2,
      name: config.name,
    };

    this.state = {
      failures: 0,
      successes: 0,
      lastFailure: null,
      state: 'closed',
    };
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit should transition from open to half-open
    if (this.state.state === 'open') {
      const timeSinceFailure = this.state.lastFailure
        ? Date.now() - this.state.lastFailure.getTime()
        : Infinity;

      if (timeSinceFailure > this.config.resetTimeout) {
        log.info?.('Circuit transitioning to half-open', { name: this.config.name });
        this.state.state = 'half-open';
        this.state.successes = 0;
      } else {
        // Circuit is still open, fail fast
        const retryAfter = Math.ceil((this.config.resetTimeout - timeSinceFailure) / 1000);
        throw new CircuitOpenError(
          `Service temporarily unavailable (circuit open). Retry after ${retryAfter}s`
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  /**
   * Record a successful operation
   */
  private onSuccess(): void {
    if (this.state.state === 'half-open') {
      this.state.successes++;
      if (this.state.successes >= this.config.successThreshold) {
        log.info?.('Circuit closing after successful recovery', {
          name: this.config.name,
          successCount: this.state.successes,
        });
        this.state.state = 'closed';
        this.state.failures = 0;
        this.state.successes = 0;
      }
    } else if (this.state.state === 'closed') {
      // Reset failure count on success in closed state
      this.state.failures = 0;
    }
  }

  /**
   * Record a failed operation
   */
  private onFailure(error: unknown): void {
    // Only count certain errors as circuit-triggering failures
    if (!this.isCircuitTriggeringError(error)) {
      return;
    }

    this.state.failures++;
    this.state.lastFailure = new Date();

    if (this.state.state === 'half-open') {
      // Any failure in half-open immediately reopens circuit
      log.warn?.('Circuit reopening due to failure in half-open state', {
        name: this.config.name,
        error: error instanceof Error ? error.message : String(error),
      });
      this.state.state = 'open';
      this.state.successes = 0;
    } else if (this.state.state === 'closed' && this.state.failures >= this.config.failureThreshold) {
      // Threshold reached, open circuit
      log.error?.('Circuit opening due to failure threshold', {
        name: this.config.name,
        failures: this.state.failures,
        threshold: this.config.failureThreshold,
        error: error instanceof Error ? error.message : String(error),
      });
      this.state.state = 'open';
    }
  }

  /**
   * Check if an error should trigger circuit breaker
   * Only network errors and 5xx errors count, not 4xx client errors
   */
  private isCircuitTriggeringError(error: unknown): boolean {
    // Check for network/connection errors
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      if (
        message.includes('econnrefused') ||
        message.includes('enotfound') ||
        message.includes('etimedout') ||
        message.includes('fetch failed') ||
        message.includes('network') ||
        error.name === 'AbortError'
      ) {
        return true;
      }
    }

    // Check for response with status property (from our api-client responses)
    const errorWithStatus = error as { status?: number };
    if (typeof errorWithStatus.status === 'number') {
      // Only 5xx and 408 (timeout) errors trigger circuit
      return errorWithStatus.status >= 500 || errorWithStatus.status === 408;
    }

    // Default: don't trigger circuit for unknown errors
    return false;
  }

  /**
   * Get current circuit state
   */
  getState(): tCircuitBreakerState {
    return this.state.state;
  }

  /**
   * Get circuit statistics
   */
  getStats(): {
    state: tCircuitBreakerState;
    failures: number;
    successes: number;
    lastFailure: Date | null;
  } {
    return {
      state: this.state.state,
      failures: this.state.failures,
      successes: this.state.successes,
      lastFailure: this.state.lastFailure,
    };
  }

  /**
   * Force reset the circuit to closed state (for testing/admin)
   */
  reset(): void {
    log.info?.('Circuit manually reset', { name: this.config.name });
    this.state = {
      failures: 0,
      successes: 0,
      lastFailure: null,
      state: 'closed',
    };
  }

  /**
   * Check if circuit is allowing requests
   */
  isAllowed(): boolean {
    if (this.state.state === 'closed') {
      return true;
    }

    if (this.state.state === 'half-open') {
      return true;
    }

    // Check if should transition to half-open
    if (this.state.state === 'open' && this.state.lastFailure) {
      const timeSinceFailure = Date.now() - this.state.lastFailure.getTime();
      return timeSinceFailure > this.config.resetTimeout;
    }

    return false;
  }
}

/**
 * Singleton circuit breaker for ats-api calls
 */
export const atsApiCircuitBreaker = new CircuitBreaker({
  name: 'ats-api',
  failureThreshold: 5,
  resetTimeout: 30000, // 30 seconds
  successThreshold: 2,
});

/**
 * Singleton circuit breaker for DO Gradient (LLM) calls
 */
export const gradientCircuitBreaker = new CircuitBreaker({
  name: 'gradient-llm',
  failureThreshold: 3,
  resetTimeout: 30000, // 30 seconds
  successThreshold: 1,
});
