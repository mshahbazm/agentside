/**
 * Factory for building `AgentTool` wrappers around your app's HTTP endpoints.
 *
 * Given a tool name, HTTP method, path template, TypeBox schema, and description,
 * this returns an `AgentTool` whose `execute` fills the path placeholders from
 * the validated arguments, sends body / query as appropriate, and returns the
 * parsed API response as tool content + details.
 *
 * This factory handles the common case. Tools that need custom behavior
 * (client-side UI blocks, response post-processing, multi-call flows) are
 * written by hand as plain `AgentTool` objects.
 */

import { type Static, type TSchema } from 'typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { AppApiClient } from './api-client';

export type tHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface iHttpToolOptions<TSchema_ extends TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: TSchema_;
  method: tHttpMethod;
  /** Path template with `:param` placeholders (companyId is filled automatically). */
  path: string;
  /**
   * Optional success message builder — defaults to "Completed {name}" plus the
   * raw response. Override for friendlier text in the tool result content.
   */
  formatSuccess?: (result: unknown, args: Static<TSchema_>) => string;
  /**
   * Optional detail extractor — what goes into the `details` field of the
   * tool result (separate from `content` which the LLM sees). Defaults to
   * the entire response.
   */
  extractDetails?: (result: unknown, args: Static<TSchema_>) => unknown;
}

/**
 * Build an AgentTool from a declarative HTTP route definition.
 *
 * `buildTools(ctx)` composes a flat AgentTool[] by calling this factory once
 * per endpoint, passing the per-request `AppApiClient` instance. The client
 * carries the service auth + companyId, so every tool created for a given
 * request is scoped to that request.
 */
export function httpTool<TSchema_ extends TSchema>(
  api: AppApiClient,
  opts: iHttpToolOptions<TSchema_>,
): AgentTool<TSchema_> {
  return {
    name: opts.name,
    label: opts.label,
    description: opts.description,
    parameters: opts.parameters,
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) {
        throw new Error('Aborted');
      }
      const args = params as Record<string, unknown>;
      const { path, remaining } = api.fillPath(opts.path, args);

      // Inject the trusted companyId into write-method bodies. Many backends
      // validate a tenant id in the payload even when the path already
      // contains it. We already hold the verified companyId on
      // `api.companyId` (set from the authenticated WebSocket in runtime.ts),
      // so we attach it server-side. The LLM never sees this field — it's not
      // in the TypeBox schema, so the model can't override it. Remove this if
      // your API doesn't expect a tenant id in bodies.
      const isWrite =
        opts.method === 'POST' || opts.method === 'PUT' || opts.method === 'PATCH';
      const body = isWrite ? { companyId: api.companyId, ...remaining } : remaining;

      let result: unknown;
      switch (opts.method) {
        case 'GET':
          result = await api.get(path, remaining);
          break;
        case 'POST':
          result = await api.post(path, body);
          break;
        case 'PUT':
          result = await api.put(path, body);
          break;
        case 'PATCH':
          result = await api.patch(path, body);
          break;
        case 'DELETE':
          result = await api.delete(path);
          break;
      }

      const message = opts.formatSuccess
        ? opts.formatSuccess(result, params as Static<TSchema_>)
        : JSON.stringify(result).slice(0, 4000);
      const details = opts.extractDetails
        ? opts.extractDetails(result, params as Static<TSchema_>)
        : result;

      return {
        content: [{ type: 'text' as const, text: message }],
        details,
      };
    },
  };
}
