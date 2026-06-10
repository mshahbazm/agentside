/**
 * ATS HTTP tools — every tool that maps directly to an ats-api endpoint.
 *
 * Built on top of `httpTool(ats, {...})` from shared/http-tool.ts. Each tool's
 * schema is written in TypeBox and describes the fields the LLM should pass.
 * The factory handles path parameter substitution, body/query splitting, and
 * error propagation.
 *
 * Scope: only tools referenced in the 15 SKILL.md files. Additional endpoints
 * can be added here as new skills get written.
 */

import { Type } from 'typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { AtsClient } from './shared/ats-client';
import { httpTool } from './shared/http-tool';

const fieldVisibilitySchema = Type.Union([
  Type.Literal('hidden'),
  Type.Literal('optional'),
  Type.Literal('required'),
]);

const formApplicationFieldSettingsSchema = Type.Object({
  phone: Type.Optional(fieldVisibilitySchema),
  email: Type.Optional(fieldVisibilitySchema),
  resume: Type.Optional(fieldVisibilitySchema),
  linkedIn: Type.Optional(fieldVisibilitySchema),
  portfolio: Type.Optional(fieldVisibilitySchema),
  coverLetter: Type.Optional(fieldVisibilitySchema),
  preferredCommunicationChannel: Type.Optional(fieldVisibilitySchema),
}, { additionalProperties: false });

const aiInterviewApplicationFieldSettingsSchema = Type.Object({
  phone: Type.Optional(fieldVisibilitySchema),
  email: Type.Optional(fieldVisibilitySchema),
  resume: Type.Optional(fieldVisibilitySchema),
}, { additionalProperties: false });

const applicationFormSettingsSchema = Type.Object({
  form: Type.Optional(formApplicationFieldSettingsSchema),
  aiInterview: Type.Optional(aiInterviewApplicationFieldSettingsSchema),
}, { additionalProperties: false });

export function buildAtsTools(ats: AtsClient): AgentTool<any>[] {
  return [
    // ========================================================================
    // Jobs
    // ========================================================================
    httpTool(ats, {
      name: 'job_create',
      label: 'Create job',
      description:
        'Create a new job posting. Include title (required) and any other fields the user mentioned: content (HTML), departmentCode, locationCodes, primaryLocationCode, commitmentType, workMode, experienceLevel, payRateFrequency, payType, rateMin, rateMax, rateCurrency, status, visibility, skills, optionalSkills, questions (screening), timeZone, targetHires, assignedToCode. Only set fields you have real data for.',
      parameters: Type.Object({
        title: Type.String({ description: 'Job title' }),
        content: Type.Optional(Type.String({ description: 'Job description as HTML' })),
        departmentCode: Type.Optional(Type.Number()),
        locationCodes: Type.Optional(Type.Array(Type.Number())),
        primaryLocationCode: Type.Optional(Type.Number()),
        commitmentType: Type.Optional(
          Type.Union([
            Type.Literal('full_time'),
            Type.Literal('contract'),
            Type.Literal('part_time'),
            Type.Literal('internship'),
            Type.Literal('temporary'),
            Type.Literal('volunteer'),
          ]),
        ),
        workMode: Type.Optional(
          Type.Union([Type.Literal('remote'), Type.Literal('hybrid'), Type.Literal('on-site')]),
        ),
        experienceLevel: Type.Optional(
          Type.Union([
            Type.Literal('entry_level'),
            Type.Literal('mid_senior_level'),
            Type.Literal('director'),
            Type.Literal('executive'),
            Type.Literal('internship'),
            Type.Literal('associate'),
            Type.Literal('not_applicable'),
          ]),
        ),
        payRateFrequency: Type.Optional(
          Type.Union([
            Type.Literal('hourly'),
            Type.Literal('daily'),
            Type.Literal('weekly'),
            Type.Literal('biweekly'),
            Type.Literal('semimonthly'),
            Type.Literal('monthly'),
            Type.Literal('yearly'),
          ]),
        ),
        payType: Type.Optional(
          Type.Union([Type.Literal('base_salary'), Type.Literal('other')]),
        ),
        rateMin: Type.Optional(Type.String({ description: 'Decimal string e.g. "2000.00"' })),
        rateMax: Type.Optional(Type.String()),
        rateCurrency: Type.Optional(Type.String({ description: 'ISO 4217, e.g. "USD"' })),
        status: Type.Optional(
          Type.Union([
            Type.Literal('draft'),
            Type.Literal('published'),
            Type.Literal('paused'),
            Type.Literal('closed'),
            Type.Literal('archived'),
          ]),
        ),
        visibility: Type.Optional(
          Type.Union([
            Type.Literal('public'),
            Type.Literal('internal'),
            Type.Literal('unlisted'),
          ]),
        ),
        skills: Type.Optional(Type.Array(Type.String())),
        optionalSkills: Type.Optional(Type.Array(Type.String())),
        questions: Type.Optional(
          Type.Array(
            Type.Object({
              question: Type.String(),
              required: Type.Boolean(),
              type: Type.Union([
                Type.Literal('yes_no'),
                Type.Literal('numeric'),
                Type.Literal('short_text'),
                Type.Literal('long_text'),
                Type.Literal('multi_select'),
              ]),
              isKnockout: Type.Optional(Type.Boolean()),
              options: Type.Optional(Type.Array(Type.String())),
            }),
          ),
        ),
        timeZone: Type.Optional(Type.String()),
        isEvergreen: Type.Optional(Type.Boolean()),
        targetHires: Type.Optional(Type.Number()),
        assignedToCode: Type.Optional(Type.Number()),
        applicationFormSettings: Type.Optional(applicationFormSettingsSchema),
      }),
      method: 'POST',
      path: '/companies/:companyId/jobs',
      formatSuccess: (r) => {
        const code = (r as { code?: number })?.code;
        return `Created job${code ? ` #${code}` : ''}.`;
      },
    }),

    httpTool(ats, {
      name: 'job_update',
      label: 'Update job',
      description:
        'Update an existing job posting. Always include the job `code` and ONLY the fields that are changing. Do not send unchanged fields. Never update content (job description) here — use job_description_update for that.',
      parameters: Type.Object({
        code: Type.Number({ description: 'Job code' }),
        title: Type.Optional(Type.String()),
        departmentCode: Type.Optional(Type.Number()),
        locationCodes: Type.Optional(Type.Array(Type.Number())),
        primaryLocationCode: Type.Optional(Type.Number()),
        commitmentType: Type.Optional(Type.String()),
        workMode: Type.Optional(Type.String()),
        experienceLevel: Type.Optional(Type.String()),
        payRateFrequency: Type.Optional(Type.String()),
        rateMin: Type.Optional(Type.String()),
        rateMax: Type.Optional(Type.String()),
        rateCurrency: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()),
        visibility: Type.Optional(Type.String()),
        skills: Type.Optional(Type.Array(Type.String())),
        optionalSkills: Type.Optional(Type.Array(Type.String())),
        timeZone: Type.Optional(Type.String()),
        assignedToCode: Type.Optional(Type.Number()),
        applicationFormSettings: Type.Optional(applicationFormSettingsSchema),
        closeReason: Type.Optional(
          Type.Union([
            Type.Literal('filled'),
            Type.Literal('on_hold'),
            Type.Literal('cancelled'),
            Type.Literal('other'),
          ]),
        ),
      }),
      method: 'PUT',
      path: '/companies/:companyId/jobs/:code',
      formatSuccess: (_r, args) => `Updated job #${(args as { code: number }).code}.`,
    }),

    httpTool(ats, {
      name: 'job_get',
      label: 'Get job',
      description: 'Fetch full details of a single job by code.',
      parameters: Type.Object({
        code: Type.Number({ description: 'Job code' }),
      }),
      method: 'GET',
      path: '/companies/:companyId/jobs/:code',
    }),

    httpTool(ats, {
      name: 'job_summary_list',
      label: 'Search jobs',
      description:
        'Search job listings by title or query. Returns recent jobs sorted by creation date, prioritizing open/published. Use when the user references another job by name ("create a job like X").',
      parameters: Type.Object({
        search: Type.Optional(Type.String({ description: 'Search query (job title)' })),
        limit: Type.Optional(Type.Number()),
      }),
      method: 'GET',
      path: '/companies/:companyId/jobs/summary',
    }),

    httpTool(ats, {
      name: 'job_context',
      label: 'Job context',
      description:
        'Fetch a job or standalone interview context by code. Returns type ("job" or "standalone_interview"), title, status, and the full stages list with interview info. Use when the user references a job or interview and you need to understand its structure.',
      parameters: Type.Object({
        code: Type.Number({ description: 'Job or interview code' }),
      }),
      method: 'GET',
      path: '/companies/:companyId/jobs/:code/context',
    }),

    httpTool(ats, {
      name: 'job_description_get',
      label: 'Get job description',
      description:
        'Fetch current job description content and the active default JD template for a job. Used as the first step in update_job_description flow.',
      parameters: Type.Object({
        code: Type.Number({ description: 'Job code' }),
      }),
      method: 'POST',
      path: '/companies/:companyId/jobs/:code/description/get',
    }),

    httpTool(ats, {
      name: 'job_description_update',
      label: 'Update job description',
      description: 'Save updated job description HTML for a job.',
      parameters: Type.Object({
        code: Type.Number({ description: 'Job code' }),
        content: Type.String({ description: 'New HTML job description' }),
      }),
      method: 'PUT',
      path: '/companies/:companyId/jobs/:code/description',
    }),

    // ========================================================================
    // Interviews (stage + standalone + design context)
    // ========================================================================
    httpTool(ats, {
      name: 'interview_get',
      label: 'Get interview',
      description:
        'Fetch interview config for a job stage or standalone interview. For standalone interviews, pass only code (no stageId). For job stage interviews, pass both code and stageId. Response includes current questions and rubricTemplateCode.',
      parameters: Type.Object({
        code: Type.Number({ description: 'Job or standalone interview code' }),
        stageId: Type.Optional(
          Type.String({ description: 'Stage ID for job pipeline interviews' }),
        ),
      }),
      method: 'GET',
      path: '/companies/:companyId/jobs/:code/interview',
    }),

    httpTool(ats, {
      name: 'interview_design_context',
      label: 'Interview design context',
      description:
        'Fetch everything needed to design interview questions in one call: job context, interview config (current questions, scorecard, channel, duration), job description, and stage actions. Pass stageId when targeting a specific AI stage within a multi-stage job.',
      parameters: Type.Object({
        code: Type.Number({ description: 'Job or standalone interview code' }),
        stageId: Type.Optional(Type.String({
          description: 'UUID of a specific stage — MUST come from `stages[].stageId` in a prior response. Never pass the stage NAME.',
        })),
      }),
      method: 'GET',
      path: '/companies/:companyId/jobs/:code/design-context',
    }),

    httpTool(ats, {
      name: 'stage_interview_update',
      label: 'Update stage questions',
      description:
        'Replace the interview question list for a specific stage in a job pipeline. Pass the full new list of question strings.',
      parameters: Type.Object({
        code: Type.Number({ description: 'Job code' }),
        stageId: Type.String({ description: 'Stage ID' }),
        questions: Type.Array(Type.String(), { description: 'Full replacement list of question texts' }),
      }),
      method: 'PUT',
      path: '/companies/:companyId/jobs/:code/stages/:stageId/interview/questions',
    }),

    httpTool(ats, {
      name: 'standalone_interview_list',
      label: 'List standalone interviews',
      description: 'Search and list standalone AI interviews.',
      parameters: Type.Object({
        search: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()),
        page: Type.Optional(Type.Number()),
        perPage: Type.Optional(Type.Number()),
      }),
      method: 'GET',
      path: '/companies/:companyId/standalone-interviews',
    }),

    httpTool(ats, {
      name: 'standalone_interview_update',
      label: 'Update standalone interview',
      description:
        'Update a standalone interview. Pass only the fields being changed (code is required). When updating questions, pass the full new list — it replaces the existing questions.',
      parameters: Type.Object({
        code: Type.Number(),
        title: Type.Optional(Type.String()),
        content: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()),
        questions: Type.Optional(Type.Array(Type.String())),
      }),
      method: 'PUT',
      path: '/companies/:companyId/standalone-interviews/:code',
    }),

    // ========================================================================
    // Departments
    // ========================================================================
    httpTool(ats, {
      name: 'department_list',
      label: 'List departments',
      description: 'List all departments in the company. Use to find a department code by name.',
      parameters: Type.Object({}),
      method: 'GET',
      path: '/companies/:companyId/departments',
    }),

    // ========================================================================
    // Email templates
    // ========================================================================
    httpTool(ats, {
      name: 'email_template_list',
      label: 'List email templates',
      description: 'Search and list email templates. Supports search, tag filters, pagination.',
      parameters: Type.Object({
        search: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        page: Type.Optional(Type.Number()),
        perPage: Type.Optional(Type.Number()),
      }),
      method: 'GET',
      path: '/companies/:companyId/email-templates',
    }),

    httpTool(ats, {
      name: 'email_template_create',
      label: 'Create email template',
      description:
        'Create an email template. Body must use variables from the email variable catalog (fetch via command_email_template_prepare first).',
      parameters: Type.Object({
        name: Type.String(),
        subject: Type.String(),
        body: Type.String({ description: 'HTML body' }),
        tags: Type.Optional(Type.Array(Type.String())),
        departmentCode: Type.Optional(Type.Number()),
      }),
      method: 'POST',
      path: '/companies/:companyId/email-templates',
    }),

    httpTool(ats, {
      name: 'email_template_update',
      label: 'Update email template',
      description:
        'Update an email template. Pass only the fields being changed (code is required). Do not resend unchanged fields.',
      parameters: Type.Object({
        code: Type.Number(),
        name: Type.Optional(Type.String()),
        subject: Type.Optional(Type.String()),
        body: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        departmentCode: Type.Optional(Type.Number()),
      }),
      method: 'PUT',
      path: '/companies/:companyId/email-templates/:code',
    }),

    httpTool(ats, {
      name: 'send_email_to_applicant',
      label: 'Send email to applicant',
      description:
        'Send an email to an applicant. Use confirm_action before calling this. Include the applicationCode and either a templateCode + variables or raw subject+body.',
      parameters: Type.Object({
        applicationCode: Type.Number(),
        templateCode: Type.Optional(Type.Number()),
        subject: Type.Optional(Type.String()),
        body: Type.Optional(Type.String()),
      }),
      method: 'POST',
      path: '/companies/:companyId/emails/send',
    }),

    // ========================================================================
    // Scorecards (rubric templates)
    // ========================================================================
    httpTool(ats, {
      name: 'scorecard_list',
      label: 'List scorecards',
      description: 'List all scorecard (rubric) templates with their criteria.',
      parameters: Type.Object({}),
      method: 'GET',
      path: '/companies/:companyId/rubric-templates',
    }),

    httpTool(ats, {
      name: 'scorecard_get',
      label: 'Get scorecard',
      description:
        'Fetch a scorecard template by code. Returns criteria with weights and locked status (usageCount > 0 means locked).',
      parameters: Type.Object({
        code: Type.Number(),
      }),
      method: 'GET',
      path: '/companies/:companyId/rubric-templates/:code',
    }),

    httpTool(ats, {
      name: 'scorecard_create',
      label: 'Create scorecard',
      description:
        'Create a new scorecard template with criteria. Weights must sum to 100. The rating scale cannot be changed after creation.',
      parameters: Type.Object({
        name: Type.String(),
        description: Type.Optional(Type.String()),
        ratingScale: Type.Union([Type.Literal(3), Type.Literal(4), Type.Literal(5)]),
        criteria: Type.Array(
          Type.Object({
            name: Type.String(),
            description: Type.Optional(Type.String()),
            weight: Type.Number({ description: 'Percentage 0-100' }),
            orderIndex: Type.Number(),
            scoreDefinitions: Type.Optional(
              Type.Array(Type.Object({ score: Type.Number(), text: Type.String() })),
            ),
          }),
        ),
      }),
      method: 'POST',
      path: '/companies/:companyId/rubric-templates',
    }),

    httpTool(ats, {
      name: 'scorecard_update',
      label: 'Update scorecard',
      description:
        'Update a scorecard template. Pass the full criteria array — locked criteria must be preserved unchanged. Weights must still sum to 100.',
      parameters: Type.Object({
        code: Type.Number(),
        name: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        criteria: Type.Optional(
          Type.Array(
            Type.Object({
              id: Type.Optional(Type.String({ description: 'Existing criterion ID (preserve for locked)' })),
              name: Type.String(),
              description: Type.Optional(Type.String()),
              weight: Type.Number(),
              orderIndex: Type.Number(),
              scoreDefinitions: Type.Optional(
                Type.Array(Type.Object({ score: Type.Number(), text: Type.String() })),
              ),
            }),
          ),
        ),
      }),
      method: 'PUT',
      path: '/companies/:companyId/rubric-templates/:code',
    }),

    // ========================================================================
    // Applicants
    // ========================================================================
    httpTool(ats, {
      name: 'applicant_search',
      label: 'Search applicants',
      description:
        'Search for applicants by name, skills, experience, or description of ideal candidate. Scope to a specific job with jobCode, or omit for company-wide talent pool.',
      parameters: Type.Object({
        query: Type.String({ description: 'Search query' }),
        jobCode: Type.Optional(Type.Number()),
        page: Type.Optional(Type.Number()),
        perPage: Type.Optional(Type.Number()),
      }),
      method: 'GET',
      path: '/companies/:companyId/candidates',
    }),

    httpTool(ats, {
      name: 'applicant_move_stage',
      label: 'Move applicant',
      description:
        'Move a single applicant to a specific stage. Requires jobCode, applicationCode, and the target stage (category + orderIndex or stageId).',
      parameters: Type.Object({
        jobCode: Type.Number(),
        applicationCode: Type.Number(),
        stageId: Type.Optional(Type.String()),
        category: Type.Optional(Type.String()),
        orderIndex: Type.Optional(Type.Number()),
      }),
      method: 'POST',
      path: '/companies/:companyId/jobs/:jobCode/applications/:applicationCode/stage',
    }),

    httpTool(ats, {
      name: 'applicant_bulk_action',
      label: 'Bulk applicant action',
      description:
        'Move or reject multiple applicants at once. ALWAYS call confirm_action first. Action is either "move" (requires targetStage) or "reject" (requires reason).',
      parameters: Type.Object({
        jobCode: Type.Number(),
        applicationCodes: Type.Array(Type.Number()),
        action: Type.Union([Type.Literal('move'), Type.Literal('reject')]),
        stageId: Type.Optional(Type.String()),
        reason: Type.Optional(Type.String()),
      }),
      method: 'POST',
      path: '/companies/:companyId/jobs/:jobCode/applications/bulk-stage-change',
    }),

    httpTool(ats, {
      name: 'applicant_compare',
      label: 'Compare applicants',
      description: 'Compare 2-3 candidates side-by-side for a specific job.',
      parameters: Type.Object({
        jobCode: Type.Number(),
        applicationCodes: Type.Array(Type.Number(), { description: 'Array of 2-3 application codes' }),
      }),
      method: 'GET',
      path: '/companies/:companyId/jobs/:jobCode/applications/compare',
    }),

    httpTool(ats, {
      name: 'pipeline_health_check',
      label: 'Pipeline health check',
      description:
        'Analyze a job pipeline for bottlenecks, stage distribution, and actionable insights.',
      parameters: Type.Object({
        jobCode: Type.Number(),
      }),
      method: 'GET',
      path: '/companies/:companyId/jobs/:jobCode/applicants/pipeline',
    }),

    httpTool(ats, {
      name: 'job_stats_get',
      label: 'Job stats',
      description: 'Fetch quick funnel stats (stage counts) for a job.',
      parameters: Type.Object({
        jobCode: Type.Number(),
      }),
      method: 'GET',
      path: '/companies/:companyId/jobs/:jobCode/applicants/board',
    }),
  ];
}
