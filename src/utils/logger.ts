/**
 * Structured Logger
 * Provides consistent, structured logging across the service
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface iLogContext {
  requestId?: string;
  commandId?: string;
  companyId?: string;
  intent?: string;
  [key: string]: unknown;
}

interface iLogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  component: string;
  message: string;
  context?: iLogContext;
  error?: {
    message: string;
    stack?: string;
  };
}

/**
 * Environment check for JSON logging
 */
const USE_JSON_LOGS = process.env.LOG_FORMAT === 'json';

/**
 * Format log entry for output
 */
function formatLog(entry: iLogEntry): string {
  if (USE_JSON_LOGS) {
    return JSON.stringify(entry);
  }

  // Human-readable format for development
  const contextStr = entry.context
    ? ` ${Object.entries(entry.context)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}`
    : '';

  const errorStr = entry.error ? ` | Error: ${entry.error.message}` : '';

  return `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.component}]${contextStr} ${entry.message}${errorStr}`;
}

/**
 * Create a logger for a specific component
 */
export function createLogger(component: string) {
  const log = (level: LogLevel, message: string, context?: iLogContext, error?: Error) => {
    const entry: iLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: 'command-service',
      component,
      message,
    };

    if (context && Object.keys(context).length > 0) {
      entry.context = context;
    }

    if (error) {
      entry.error = {
        message: error.message,
        stack: error.stack,
      };
    }

    const formatted = formatLog(entry);

    switch (level) {
      case 'debug':
        console.debug(formatted);
        break;
      case 'info':
        console.log(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'error':
        console.error(formatted);
        break;
    }
  };

  return {
    debug: (message: string, context?: iLogContext) => log('debug', message, context),
    info: (message: string, context?: iLogContext) => log('info', message, context),
    warn: (message: string, context?: iLogContext, error?: Error) => log('warn', message, context, error),
    error: (message: string, context?: iLogContext, error?: Error) => log('error', message, context, error),
  };
}

/**
 * Pre-configured loggers for common components
 */
export const loggers = {
  route: createLogger('Route'),
  worker: createLogger('Worker'),
  queue: createLogger('Queue'),
  executor: createLogger('Executor'),
  apiClient: createLogger('ApiClient'),
  notifications: createLogger('Notifications'),
  ws: createLogger('WebSocket'),
  ai: createLogger('AI'),
  db: createLogger('Database'),
};
