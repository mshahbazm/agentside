/**
 * Your app's tool catalog. THIS IS THE MAIN EXTENSION POINT.
 *
 * Each tool is a thin, declarative wrapper over one of your API endpoints —
 * the agent calls it, `AppApiClient` sends the request with service auth
 * (x-internal-key) plus the acting user's id (X-Act-As-User-Id), and YOUR API
 * enforces authorization exactly as it does for normal frontend traffic.
 *
 * Conventions that keep agents reliable:
 *  - Tool names are snake_case (`invoice_create`), grouped by resource.
 *  - Descriptions tell the model WHEN to call the tool, not just what it does.
 *  - Reference every tool from at least one SKILL.md — unreferenced tools are
 *    dead weight in the prompt.
 *  - For drift-prone arguments (nested required fields, enums the model may
 *    get wrong), add a `prepareArguments` hook to backfill/coerce BEFORE
 *    schema validation. See pi-agent-core's AgentTool interface.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { AppApiClient } from './shared/api-client';

// Example — a complete HTTP tool wrapping `POST /companies/:companyId/invoices`.
// Uncomment, adapt to a real endpoint, and add it to the returned array:
//
// import { Type } from 'typebox';
// import { httpTool } from './shared/http-tool';
//
// const invoiceCreate = (api: AppApiClient) =>
//   httpTool(api, {
//     name: 'invoice_create',
//     label: 'Create invoice',
//     description:
//       'Create a draft invoice for a customer. Call when the user asks to bill ' +
//       'or invoice someone. Requires a customer id — look it up first if you ' +
//       'only have a name.',
//     parameters: Type.Object({
//       customerId: Type.String({ description: 'Existing customer id' }),
//       amountCents: Type.Number({ description: 'Total in cents' }),
//       currency: Type.Union([Type.Literal('USD'), Type.Literal('EUR')]),
//       memo: Type.Optional(Type.String()),
//     }),
//     method: 'POST',
//     path: '/companies/:companyId/invoices',
//     formatSuccess: (result) => `Invoice created: ${JSON.stringify(result).slice(0, 500)}`,
//   });

export function buildAppTools(_api: AppApiClient): AgentTool<any>[] {
  return [
    // invoiceCreate(_api),
  ];
}
