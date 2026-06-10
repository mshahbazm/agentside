/**
 * Command helper tools — consolidated endpoints under `/companies/:companyId/command/*`.
 *
 * These are multi-step operations that the old scout exposed as single tools
 * so the LLM could do in one call what would otherwise take three. They
 * resolve names to codes, look up templates, and create-with-related-records
 * server-side.
 *
 * Each helper is still a thin HTTP wrapper — the "consolidation" is on the
 * ats-api side. We just forward args and surface the response.
 */

import { Type } from 'typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { AtsClient } from './shared/ats-client';
import { httpTool } from './shared/http-tool';

export function buildCommandHelperTools(ats: AtsClient): AgentTool<any>[] {
  return [
    // ========================================================================
    // Departments
    // ========================================================================
    httpTool(ats, {
      name: 'command_department_create',
      label: 'Create department',
      description:
        'Create a department with automatic duplicate detection. Returns { created: true, department } on success, or { created: false, nearMatches } when similar departments exist.',
      parameters: Type.Object({
        name: Type.String({ description: 'Department name (capitalize properly, expand abbreviations)' }),
        description: Type.Optional(Type.String()),
      }),
      method: 'POST',
      path: '/companies/:companyId/command/departments/create',
    }),

    httpTool(ats, {
      name: 'command_department_update',
      label: 'Update department',
      description:
        'Find a department by name or abbreviation and update it. Returns { updated: true } on success, { matches } for disambiguation, or { notFound: true }.',
      parameters: Type.Object({
        identifier: Type.String({ description: 'Department name or abbreviation' }),
        updates: Type.Object({
          name: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
        }),
      }),
      method: 'POST',
      path: '/companies/:companyId/command/departments/update',
    }),

    // ========================================================================
    // Locations
    // ========================================================================
    httpTool(ats, {
      name: 'command_location_create',
      label: 'Create location',
      description:
        'Create an office, branch, or remote location with duplicate detection. Returns { created: true, location } or { created: false, nearMatches }.',
      parameters: Type.Object({
        name: Type.String(),
        type: Type.Optional(
          Type.Union([
            Type.Literal('office'),
            Type.Literal('branch'),
            Type.Literal('headquarters'),
            Type.Literal('remote_hub'),
            Type.Literal('other'),
          ]),
        ),
        isRemote: Type.Optional(Type.Boolean()),
        city: Type.Optional(Type.String()),
        state: Type.Optional(Type.String()),
        countryCode: Type.Optional(Type.String({ description: 'ISO 3166-1 alpha-2, e.g. "US"' })),
        timeZone: Type.Optional(Type.String({ description: 'IANA timezone, e.g. "America/New_York"' })),
        addressLine1: Type.Optional(Type.String()),
        addressLine2: Type.Optional(Type.String()),
        postalCode: Type.Optional(Type.String()),
      }),
      method: 'POST',
      path: '/companies/:companyId/command/locations/create',
    }),

    // ========================================================================
    // Jobs (prepare helpers)
    // ========================================================================
    httpTool(ats, {
      name: 'command_job_prepare',
      label: 'Prepare job create',
      description:
        'Fetch the default job description template and resolve department/location names to codes in one call. Call this BEFORE `job_create` when the user mentioned a department or location, or when drafting content should follow the default JD template.',
      parameters: Type.Object({
        departmentName: Type.Optional(Type.String()),
        locationName: Type.Optional(Type.String()),
        departmentCode: Type.Optional(Type.Number()),
      }),
      method: 'GET',
      path: '/companies/:companyId/command/jobs/prepare',
    }),

    httpTool(ats, {
      name: 'command_job_prepare_update',
      label: 'Prepare job update',
      description:
        'Fetch the current job data plus resolved department/location codes in one call. Use before `job_update` to understand the current state.',
      parameters: Type.Object({
        code: Type.Number({ description: 'Job code' }),
        departmentName: Type.Optional(Type.String()),
        locationName: Type.Optional(Type.String()),
      }),
      method: 'GET',
      path: '/companies/:companyId/command/jobs/:code/prepare-update',
    }),

    // ========================================================================
    // Workflow templates
    // ========================================================================
    httpTool(ats, {
      name: 'command_workflow_prepare',
      label: 'Prepare workflow create',
      description:
        'Fetch stageCategories (each with supportedStageTypes), defaultStages, and existingWorkflowTemplates. Call FIRST before designing a workflow template.',
      parameters: Type.Object({}),
      method: 'GET',
      path: '/companies/:companyId/command/workflow-templates/prepare',
    }),

    httpTool(ats, {
      name: 'command_workflow_create',
      label: 'Create workflow template',
      description:
        'Create a workflow template with stages, stage actions, and an email template in one call. The server resolves stage orderIndex to UUIDs and {{templateId}} placeholders to the created email template id.',
      parameters: Type.Object({
        name: Type.String(),
        desc: Type.Optional(Type.String()),
        departmentCode: Type.Optional(Type.Number()),
        stages: Type.Array(
          Type.Object({
            name: Type.String(),
            category: Type.Union([
              Type.Literal('sourcing'),
              Type.Literal('application'),
              Type.Literal('evaluation'),
              Type.Literal('offer'),
              Type.Literal('closed'),
            ]),
            orderIndex: Type.Number(),
            typeId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
        ),
        emailTemplateSearch: Type.Optional(Type.String()),
        emailTemplateCreate: Type.Optional(
          Type.Object({
            name: Type.String(),
            subject: Type.String(),
            body: Type.String(),
            tags: Type.Optional(Type.Array(Type.String())),
          }),
        ),
        stageActions: Type.Optional(
          Type.Array(
            Type.Object({
              stageOrderIndex: Type.Number(),
              slot: Type.Union([Type.Literal('entry'), Type.Literal('pre'), Type.Literal('post')]),
              actions: Type.Array(
                Type.Object({
                  name: Type.String(),
                  capabilityId: Type.String(),
                  config: Type.Optional(Type.Record(Type.String(), Type.Any())),
                  orderIndex: Type.Number(),
                  onFailure: Type.Optional(
                    Type.Union([Type.Literal('continue'), Type.Literal('stop')]),
                  ),
                }),
              ),
            }),
          ),
        ),
      }),
      method: 'POST',
      path: '/companies/:companyId/command/workflow-templates/create-with-actions',
    }),

    httpTool(ats, {
      name: 'command_job_clone_workflow',
      label: 'Apply workflow template to job',
      description:
        'Clone all stages and stage actions from a workflow template into a job\'s hiring pipeline. This sets up the job\'s workflow by copying the template — it does NOT create a new template. The job must not already have custom stages.',
      parameters: Type.Object({
        code: Type.Number({ description: 'Job code' }),
        templateCode: Type.Number({ description: 'Workflow template code' }),
      }),
      method: 'POST',
      path: '/companies/:companyId/jobs/:code/clone-stages',
    }),

    // ========================================================================
    // Team
    // ========================================================================
    httpTool(ats, {
      name: 'command_team_invite',
      label: 'Invite team member',
      description:
        'Invite a team member. If roleName is provided, the server resolves it. Returns { invited: true } or { availableRoles } / { roleMatches } for disambiguation.',
      parameters: Type.Object({
        email: Type.String(),
        roleName: Type.Optional(Type.String()),
        roleCode: Type.Optional(Type.Number()),
        name: Type.Optional(Type.String()),
      }),
      method: 'POST',
      path: '/companies/:companyId/command/team/invite',
    }),

    httpTool(ats, {
      name: 'command_team_update_role',
      label: 'Update team member role',
      description:
        'Find a team member (by email, name, or code) and update their role (by name or code). Returns updated status or disambiguation options.',
      parameters: Type.Object({
        memberEmail: Type.Optional(Type.String()),
        memberName: Type.Optional(Type.String()),
        memberCode: Type.Optional(Type.Number()),
        roleName: Type.Optional(Type.String()),
        roleCode: Type.Optional(Type.Number()),
      }),
      method: 'POST',
      path: '/companies/:companyId/command/team/members/update-role',
    }),

    // ========================================================================
    // Standalone interviews
    // ========================================================================
    httpTool(ats, {
      name: 'command_standalone_interview_create',
      label: 'Create standalone interview',
      description:
        'Create a standalone AI interview with auto-selected general scorecard (by default). Provide title, optional content, and questions array.',
      parameters: Type.Object({
        title: Type.String(),
        content: Type.Optional(Type.String()),
        questions: Type.Array(Type.String()),
        rubricTemplateCode: Type.Optional(Type.Number()),
        autoSelectScorecard: Type.Optional(Type.Boolean()),
      }),
      method: 'POST',
      path: '/companies/:companyId/command/standalone-interviews/create',
    }),

    // ========================================================================
    // Email templates
    // ========================================================================
    httpTool(ats, {
      name: 'command_email_template_prepare',
      label: 'Prepare email template',
      description:
        'Fetch the email variable catalog (and optionally an existing template for update flows) in one call. ALWAYS call this before drafting or updating an email template.',
      parameters: Type.Object({
        templateCode: Type.Optional(Type.Number()),
      }),
      method: 'GET',
      path: '/companies/:companyId/command/email-templates/prepare',
    }),
  ];
}
