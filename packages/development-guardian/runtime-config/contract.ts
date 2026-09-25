import { z } from 'zod'

import {
  isSupportedCodexConfiguration,
  type CodexReasoningEffort,
} from '../coding-executor-config.js'
import type { RuntimeModelAdapter, RuntimeModelPolicy } from './model-policy.js'

const ReasoningLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const RuntimeModelSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(128),
  displayName: z.string().trim().min(1).max(128),
  supportsReasoning: z.boolean(),
  reasoningLevels: z.array(ReasoningLevelSchema),
  defaultReasoningLevel: ReasoningLevelSchema.nullable(),
}).strict()
const RuntimePresetSchema = z.object({
  model: z.string().trim().min(1).max(128),
  reasoningLevel: ReasoningLevelSchema.nullable(),
}).strict()
const RuntimeConfigV1Schema = z.object({
  version: z.literal(1),
  models: z.array(RuntimeModelSchema),
  presets: z.record(z.string().trim().min(1).max(64), RuntimePresetSchema),
}).strict()

export type RuntimeConfigV1 = z.infer<typeof RuntimeConfigV1Schema>
export type RuntimeConfigModelV1 = z.infer<typeof RuntimeModelSchema>

export class RuntimeConfigValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeConfigValidationError'
  }
}

function runtimeAdapter(provider: string): RuntimeModelAdapter {
  if (provider === 'openai') return 'codex'
  if (provider === 'deepseek') return 'deepseek'
  throw new RuntimeConfigValidationError(`Unsupported runtime-config provider: ${provider}`)
}

function validateModel(model: RuntimeConfigModelV1): void {
  const uniqueLevels = new Set(model.reasoningLevels)
  if (uniqueLevels.size !== model.reasoningLevels.length) {
    throw new RuntimeConfigValidationError(`Duplicate reasoning level for model ${model.model}`)
  }
  if (!model.supportsReasoning) {
    if (model.reasoningLevels.length !== 0 || model.defaultReasoningLevel !== null) {
      throw new RuntimeConfigValidationError(`Non-reasoning model ${model.model} declares reasoning settings`)
    }
  } else {
    if (model.reasoningLevels.length === 0 || model.defaultReasoningLevel === null || !uniqueLevels.has(model.defaultReasoningLevel)) {
      throw new RuntimeConfigValidationError(`Reasoning model ${model.model} has no valid default reasoning level`)
    }
  }
  const adapter = runtimeAdapter(model.provider)
  if (adapter === 'deepseek') {
    if (model.model !== 'sonnet' || model.supportsReasoning) {
      throw new RuntimeConfigValidationError(`Unsupported DeepSeek runtime model: ${model.model}`)
    }
    return
  }
  for (const level of model.reasoningLevels) {
    if (!isSupportedCodexConfiguration(model.model, level)) {
      throw new RuntimeConfigValidationError(`Unsupported Codex model/reasoning configuration: ${model.model}/${level}`)
    }
  }
}

function selectionFor(
  key: 'implementation' | 'review',
  config: RuntimeConfigV1,
  models: ReadonlyMap<string, RuntimeConfigModelV1>,
): RuntimeModelPolicy[typeof key] {
  const preset = config.presets[key]
  if (preset === undefined) throw new RuntimeConfigValidationError(`Missing operational preset: ${key}`)
  const model = models.get(preset.model)
  if (model === undefined) throw new RuntimeConfigValidationError(`Preset ${key} references an unknown model`)
  if (preset.reasoningLevel !== null && !model.reasoningLevels.includes(preset.reasoningLevel)) {
    throw new RuntimeConfigValidationError(`Preset ${key} has unsupported reasoning for ${model.model}`)
  }
  const adapter = runtimeAdapter(model.provider)
  const reasoning = preset.reasoningLevel ?? model.defaultReasoningLevel
  if (adapter === 'codex') {
    if (reasoning === null || !isSupportedCodexConfiguration(model.model, reasoning)) {
      throw new RuntimeConfigValidationError(`Preset ${key} is not operationally usable by Codex`)
    }
    return { adapter, model: model.model, reasoningEffort: reasoning as CodexReasoningEffort }
  }
  if (reasoning !== null) throw new RuntimeConfigValidationError(`Preset ${key} cannot pass reasoning to DeepSeek`)
  return { adapter, model: model.model }
}

export function validateRuntimeConfigV1(input: unknown): {
  config: RuntimeConfigV1
  policy: RuntimeModelPolicy
} {
  const parsed = RuntimeConfigV1Schema.safeParse(input)
  if (!parsed.success) throw new RuntimeConfigValidationError('Runtime config does not match strict contract version 1')
  const models = new Map<string, RuntimeConfigModelV1>()
  for (const model of parsed.data.models) {
    if (models.has(model.model)) throw new RuntimeConfigValidationError(`Duplicate runtime model id: ${model.model}`)
    validateModel(model)
    models.set(model.model, model)
  }
  for (const [key, preset] of Object.entries(parsed.data.presets)) {
    if (!models.has(preset.model)) throw new RuntimeConfigValidationError(`Preset ${key} references an unknown model`)
  }
  return {
    config: parsed.data,
    policy: {
      implementation: selectionFor('implementation', parsed.data, models),
      review: selectionFor('review', parsed.data, models),
    },
  }
}

export function canonicalRuntimeConfigJson(config: RuntimeConfigV1): string {
  const presets = Object.fromEntries(Object.entries(config.presets).sort(([left], [right]) => left.localeCompare(right)))
  return JSON.stringify({ version: config.version, models: config.models, presets })
}
