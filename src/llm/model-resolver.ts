import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getModel, getProviders, getSupportedThinkingLevels } from '@mariozechner/pi-ai';
import type {
  AnthropicMessagesCompat,
  Api,
  KnownProvider,
  Model,
  ModelThinkingLevel,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
  ThinkingLevelMap,
} from '@mariozechner/pi-ai';

type tModelInput = 'text' | 'image';
type tModelCompat = OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;

interface iProviderModelConfig {
  id: string;
  name?: string;
  api?: Api;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: tModelInput[];
  cost?: Partial<Model<Api>['cost']>;
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: tModelCompat;
}

interface iProviderConfig {
  baseUrl?: string;
  api?: Api;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: tModelInput[];
  cost?: Partial<Model<Api>['cost']>;
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: tModelCompat;
  models?: iProviderModelConfig[];
}

export interface iResolveConfiguredModelOptions {
  selector: string;
  apiKey: string;
}

export interface iResolvedModel {
  model: Model<Api>;
  apiKey: string;
}

interface iParsedSelector {
  provider: string;
  modelId: string;
}

const MODEL_CONFIG_DIR = join(import.meta.dir, 'models');
const DEFAULT_COST: Model<Api>['cost'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const PREFERRED_REASONING_LEVELS: ModelThinkingLevel[] = ['medium', 'high', 'low', 'minimal', 'xhigh'];

export function parseModelSelector(selector: string): iParsedSelector {
  const trimmed = selector.trim();
  const slashIndex = trimmed.indexOf('/');

  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    throw new Error(
      `LLM_MODEL must be in "provider/model-id" format. Received: ${selector || '<empty>'}`,
    );
  }

  return {
    provider: trimmed.slice(0, slashIndex),
    modelId: trimmed.slice(slashIndex + 1),
  };
}

export function resolveConfiguredModel(opts: iResolveConfiguredModelOptions): iResolvedModel {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) {
    throw new Error('Missing required environment variable: LLM_KEY');
  }

  const { provider, modelId } = parseModelSelector(opts.selector);
  const configPath = join(MODEL_CONFIG_DIR, `${provider}.json`);

  if (isKnownProvider(provider)) {
    const builtIn = resolveBuiltInModel(provider, modelId);
    if (builtIn) {
      return { apiKey, model: builtIn };
    }
    throw new Error(`Pi built-in LLM provider "${provider}" does not know model "${modelId}".`);
  }

  if (existsSync(configPath)) {
    const config = loadProviderConfig(configPath, provider);
    const configuredModel = config.models?.find((model) => model.id === modelId);
    if (configuredModel) {
      return {
        apiKey,
        model: buildConfiguredModel(provider, config, configuredModel),
      };
    }
    throw new Error(`LLM_MODEL "${provider}/${modelId}" was not found in ${configPath}`);
  }

  throw new Error(
    `LLM provider "${provider}" is not configured. Expected custom provider config at ${configPath}.`,
  );
}

export function resolveThinkingLevel(model: Model<Api>): ModelThinkingLevel {
  if (!model.reasoning) return 'off';

  const supportedLevels = new Set(getSupportedThinkingLevels(model));
  for (const level of PREFERRED_REASONING_LEVELS) {
    if (supportedLevels.has(level)) return level;
  }
  return 'off';
}

function loadProviderConfig(configPath: string, provider: string): iProviderConfig {
  let raw: unknown;

  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read LLM provider config for "${provider}" at ${configPath}: ${message}`);
  }

  if (!isRecord(raw)) {
    throw new Error(`LLM provider config for "${provider}" must be a JSON object.`);
  }

  const config = raw as iProviderConfig;
  if (config.models !== undefined && !Array.isArray(config.models)) {
    throw new Error(`LLM provider config for "${provider}" has invalid "models"; expected an array.`);
  }

  for (const model of config.models ?? []) {
    if (!model || typeof model.id !== 'string' || model.id.trim() === '') {
      throw new Error(`LLM provider config for "${provider}" contains a model without a valid "id".`);
    }
  }

  return config;
}

function buildConfiguredModel(
  provider: string,
  providerConfig: iProviderConfig,
  modelConfig: iProviderModelConfig,
): Model<Api> {
  const api = modelConfig.api ?? providerConfig.api;
  const baseUrl = modelConfig.baseUrl ?? providerConfig.baseUrl;

  if (!api) {
    throw new Error(`LLM model "${provider}/${modelConfig.id}" is missing required "api".`);
  }
  if (!baseUrl) {
    throw new Error(`LLM model "${provider}/${modelConfig.id}" is missing required "baseUrl".`);
  }

  return {
    id: modelConfig.id,
    name: modelConfig.name ?? modelConfig.id,
    api,
    provider,
    baseUrl,
    reasoning: modelConfig.reasoning ?? providerConfig.reasoning ?? false,
    thinkingLevelMap: mergeThinkingLevelMap(providerConfig.thinkingLevelMap, modelConfig.thinkingLevelMap),
    input: modelConfig.input ?? providerConfig.input ?? ['text'],
    cost: mergeCost(providerConfig.cost, modelConfig.cost),
    contextWindow: modelConfig.contextWindow ?? providerConfig.contextWindow ?? 128000,
    maxTokens: modelConfig.maxTokens ?? providerConfig.maxTokens ?? 16384,
    headers: mergeHeaders(providerConfig.headers, modelConfig.headers),
    compat: mergeCompat(providerConfig.compat, modelConfig.compat) as Model<Api>['compat'],
  };
}

function resolveBuiltInModel(provider: string, modelId: string): Model<Api> | undefined {
  if (!isKnownProvider(provider)) return undefined;
  return getModel(provider, modelId as never) as Model<Api> | undefined;
}

function applyProviderOverrides(model: Model<Api>, config: iProviderConfig): Model<Api> {
  return {
    ...model,
    baseUrl: config.baseUrl ?? model.baseUrl,
    headers: mergeHeaders(model.headers, config.headers),
    thinkingLevelMap: mergeThinkingLevelMap(model.thinkingLevelMap, config.thinkingLevelMap),
    compat: mergeCompat(model.compat as tModelCompat | undefined, config.compat) as Model<Api>['compat'],
  };
}

function isKnownProvider(provider: string): provider is KnownProvider {
  return (getProviders() as string[]).includes(provider);
}

function mergeCost(
  providerCost: Partial<Model<Api>['cost']> | undefined,
  modelCost: Partial<Model<Api>['cost']> | undefined,
): Model<Api>['cost'] {
  return {
    ...DEFAULT_COST,
    ...providerCost,
    ...modelCost,
  };
}

function mergeHeaders(
  providerHeaders: Record<string, string> | undefined,
  modelHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!providerHeaders && !modelHeaders) return undefined;
  return {
    ...providerHeaders,
    ...modelHeaders,
  };
}

function mergeThinkingLevelMap(
  providerThinkingLevelMap: ThinkingLevelMap | undefined,
  modelThinkingLevelMap: ThinkingLevelMap | undefined,
): ThinkingLevelMap | undefined {
  if (!providerThinkingLevelMap && !modelThinkingLevelMap) return undefined;
  return {
    ...providerThinkingLevelMap,
    ...modelThinkingLevelMap,
  };
}

function mergeCompat(
  providerCompat: tModelCompat | undefined,
  modelCompat: tModelCompat | undefined,
): tModelCompat | undefined {
  if (!providerCompat && !modelCompat) return undefined;
  return {
    ...providerCompat,
    ...modelCompat,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
