import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { AcceptanceAssertion, AcceptanceCriterion, RequirementClause } from '../planning/model.js'
import { assessVerificationCommand, scopedNodeTestPath } from '../verification-command-policy.js'
import type { DeliveryTargetBinding } from './runtime-plan.js'
import type { BoundVerifier } from './staged-verification.js'

export const CAPABILITY_SCHEMA_VERSION = 1
export type CapabilityFamily = 'command' | 'http_api' | 'browser_ui' | 'filesystem' | 'git' |
  'process' | 'desktop_ui' | 'external_platform' | 'human'
export type CapabilitySupport = 'SUPPORTED' | 'UNSUPPORTED' | 'REQUIRES_EXTERNAL_ENVIRONMENT' | 'REQUIRES_HUMAN'
export type ProviderAvailability = 'AVAILABLE' | 'UNAVAILABLE' | 'EXTERNAL_ENVIRONMENT' | 'HUMAN_REQUIRED'

export interface CapabilityDefinition {
  family: CapabilityFamily
  version: string
  providerId: string
  providerVersion: string
  trustLevel: 'TRUSTED_LOCAL' | 'EXTERNAL' | 'HUMAN'
  supportedAssertionShape: string
  verificationContract: string
  requiredInputs: readonly string[]
  targetRequirements: readonly string[]
  environmentRequirements: readonly string[]
  evidenceType: string
  deterministic: boolean
  availability: ProviderAvailability
  reason: string
}

/** Registry describes collection ability; it does not approve a customer assertion. */
export const CAPABILITY_REGISTRY: Readonly<Record<CapabilityFamily, CapabilityDefinition>> = {
  command: { family: 'command', version: '1', providerId: 'existing-guarded-verifier', providerVersion: '1',
    trustLevel: 'TRUSTED_LOCAL', supportedAssertionShape: 'One assertion ID with an exact scoped test file',
    verificationContract: 'Exact trusted command, command policy and repository verification plan',
    requiredInputs: ['exactCommand', 'assertionId'], targetRequirements: ['bound repository'],
    environmentRequirements: ['existing verifier runtime'], evidenceType: 'command_execution', deterministic: false,
    availability: 'AVAILABLE', reason: 'Requires an exact trusted assertion-to-command mapping.' },
  filesystem: { family: 'filesystem', version: '1', providerId: 'scoped-filesystem-read', providerVersion: '1',
    trustLevel: 'TRUSTED_LOCAL', supportedAssertionShape: 'One explicit artifact path and file, directory or bounded content predicate',
    verificationContract: 'Explicit relative path and bounded file or directory observation',
    requiredInputs: ['relativePath', 'expectation', 'assertionId'], targetRequirements: ['bound repository'],
    environmentRequirements: [], evidenceType: 'filesystem_observation', deterministic: true,
    availability: 'AVAILABLE', reason: 'An explicit path and expected fact must be bound by a trusted rule.' },
  git: { family: 'git', version: '1', providerId: 'scoped-git-read', providerVersion: '1',
    trustLevel: 'TRUSTED_LOCAL', supportedAssertionShape: 'One branch, HEAD or clean-state fact on the bound repository',
    verificationContract: 'Read-only branch, HEAD or clean-state fact',
    requiredInputs: ['fact', 'assertionId'], targetRequirements: ['bound Git repository'],
    environmentRequirements: ['git'], evidenceType: 'git_observation', deterministic: true,
    availability: 'AVAILABLE', reason: 'An explicit Git fact must be bound by a trusted rule.' },
  http_api: { family: 'http_api', version: '1', providerId: 'loopback-http-read', providerVersion: '1',
    trustLevel: 'TRUSTED_LOCAL', supportedAssertionShape: 'One explicit loopback GET route and expected status',
    verificationContract: 'Bound loopback GET with status and bounded response digest',
    requiredInputs: ['port', 'route', 'expectedStatus', 'assertionId'], targetRequirements: ['bound local service'],
    environmentRequirements: ['listening loopback service'], evidenceType: 'http_observation', deterministic: false,
    availability: 'AVAILABLE', reason: 'A trusted route and expected outcome must be configured; HTTP status alone cannot prove business behavior.' },
  process: { family: 'process', version: '1', providerId: 'owned-process-observer', providerVersion: '1',
    trustLevel: 'TRUSTED_LOCAL', supportedAssertionShape: 'One project-owned Node entry and bounded exit observation',
    verificationContract: 'Start one repository-scoped Node entry with bounded exit evidence',
    requiredInputs: ['relativeEntry', 'expectedExitCode', 'timeoutMs', 'assertionId'], targetRequirements: ['bound repository'],
    environmentRequirements: ['node'], evidenceType: 'process_observation', deterministic: false,
    availability: 'AVAILABLE', reason: 'Requires an exact project-owned entry and expected exit contract.' },
  browser_ui: { family: 'browser_ui', version: '1', providerId: 'browser-harness-pending', providerVersion: '1',
    trustLevel: 'EXTERNAL', supportedAssertionShape: 'One bound browser route and interaction outcome',
    verificationContract: 'Bound route, interactions, DOM observations and screenshots',
    requiredInputs: ['route', 'interactionContract', 'assertionId'], targetRequirements: ['running browser application'],
    environmentRequirements: ['trusted browser harness'], evidenceType: 'browser_trace', deterministic: false,
    availability: 'EXTERNAL_ENVIRONMENT', reason: 'No trusted browser interaction harness is attached to delivery.' },
  desktop_ui: { family: 'desktop_ui', version: '1', providerId: 'desktop-harness-pending', providerVersion: '1',
    trustLevel: 'EXTERNAL', supportedAssertionShape: 'One bound desktop window and interaction outcome',
    verificationContract: 'Bound desktop window and interaction trace',
    requiredInputs: ['window', 'interactionContract', 'assertionId'], targetRequirements: ['running desktop application'],
    environmentRequirements: ['trusted desktop harness'], evidenceType: 'desktop_trace', deterministic: false,
    availability: 'EXTERNAL_ENVIRONMENT', reason: 'No trusted desktop interaction harness is attached to delivery.' },
  external_platform: { family: 'external_platform', version: '1', providerId: 'platform-harness-pending', providerVersion: '1',
    trustLevel: 'EXTERNAL', supportedAssertionShape: 'One named external platform interaction outcome',
    verificationContract: 'Named platform, real host and traceable interaction evidence',
    requiredInputs: ['platform', 'interactionContract', 'assertionId'], targetRequirements: ['target platform'],
    environmentRequirements: ['trusted platform harness'], evidenceType: 'platform_trace', deterministic: false,
    availability: 'EXTERNAL_ENVIRONMENT', reason: 'No trusted target-platform harness is attached to delivery.' },
  human: { family: 'human', version: '1', providerId: 'customer-human-acceptance', providerVersion: '1',
    trustLevel: 'HUMAN', supportedAssertionShape: 'One explicit customer acceptance decision',
    verificationContract: 'Identified human review with recorded decision and evidence',
    requiredInputs: ['reviewerIdentity', 'assertionId'], targetRequirements: ['customer acceptance context'],
    environmentRequirements: ['explicit human approval policy'], evidenceType: 'human_decision', deterministic: false,
    availability: 'HUMAN_REQUIRED', reason: 'Customer Mode does not admit blocking human-only assertions to Start Delivery.' },
}
for (const definition of Object.values(CAPABILITY_REGISTRY)) Object.freeze(definition)
Object.freeze(CAPABILITY_REGISTRY)

/** Stable contract fingerprint excludes live availability and diagnostic wording. */
export function capabilityPolicyFingerprint(): string {
  const definitions = Object.keys(CAPABILITY_REGISTRY).sort().map((family) => {
    const { availability: _availability, reason: _reason, ...contract } = CAPABILITY_REGISTRY[family as CapabilityFamily]
    return contract
  })
  return createHash('sha256').update(JSON.stringify({ schemaVersion: CAPABILITY_SCHEMA_VERSION, definitions })).digest('hex')
}

export interface CapabilityClassification { family: CapabilityFamily; ruleId: string; reason: string }
/** Shared frozen-claim rules used by admission and exact blueprint validation. */
export function claimRequirements(assertion: AcceptanceAssertion): {
  requiresMutation: boolean; requiresReread: boolean; requiresEntityContinuity: boolean;
  exactNumbers: string[]; requiresCleanup: boolean; requiresFreshState: boolean
} {
  const claim = `${assertion.observableBehavior} ${assertion.expectedOutcome} ${assertion.expectedEvidence}`
  const negativeScope = /(?:不存在|未交付|没有|不包含|不做|不提供|不涉及|无需|无.{0,16}(?:系统|功能|模块)|范围外|非本期|不引入|不新增|不实现|not include|out of scope|without)/iu.test(assertion.expectedOutcome)
  const mixedPositiveAction = /(?:取消|支付|创建|新增|下单|保存|修改|更新|删除|提交|create|update|delete|cancel|pay|submit|save)[^，。；;]{0,12}(?:可运行|成功|可用|完成|持久)/iu.test(assertion.expectedOutcome)
  const requiresMutation = (!negativeScope || mixedPositiveAction) && /(?:创建|新增|添加|修改|更新|删除|取消|支付|提交|保存|持久|下单|状态流转|create|update|delete|cancel|pay|persist|submit|save|write)/iu.test(claim)
  return {
    requiresMutation,
    requiresReread: /(?:持久|重启后|重新读取|再次读取|落库|persist|reread|reload|reopen|database)/iu.test(claim),
    requiresEntityContinuity: /(?:同一|该订单|该用户|该商品|原订单|same|identity|unchanged)/iu.test(claim),
    exactNumbers: [...new Set([...claim.matchAll(/\b\d+(?:\.\d+)?\b/gu)].map((match) => match[0]))],
    requiresCleanup: requiresMutation,
    requiresFreshState: /(?:新建|初始|空白|首次|fresh|empty|initial|seed)/iu.test(claim),
  }
}

export function claimRequiresExactComparison(assertion: AcceptanceAssertion): boolean {
  return /(?:\d+(?:\.\d+)?\s*(?:元|件|个|%|条|次|分钟|秒)|精确|准确|exact|equal)/iu.test(
    `${assertion.observableBehavior} ${assertion.expectedOutcome} ${assertion.expectedEvidence}`)
}

export function isDeliveryScopeClaim(assertion: AcceptanceAssertion, criterion: AcceptanceCriterion): boolean {
  return criterion.level === 'delivery' &&
    /(?:不存在|未交付|没有|不包含|不做|不提供|不涉及|无需|无.{0,16}(?:系统|功能|模块)|范围外|非本期|不引入|不新增|不实现|not include|out of scope|without)/iu.test(assertion.expectedOutcome)
}

export function claimExternalResidual(assertion: AcceptanceAssertion, criterion: AcceptanceCriterion): boolean {
  if (criterion.level !== 'delivery') return false
  const claim = `${assertion.expectedOutcome} ${assertion.expectedEvidence}`
  return /(?:实际登录|实际(?:商品|订单|新建订单)|界面访问|小程序[^，。；;]{0,20}(?:可运行|可用)|后台[^，。；;]{0,20}(?:可运行|可用))/iu.test(claim)
}

export function classifyCapability(input: { assertion: AcceptanceAssertion; criterion: AcceptanceCriterion;
  requirement: RequirementClause }): CapabilityClassification {
  const { criterion, assertion } = input
  const observed = `${assertion.observableBehavior} ${assertion.expectedOutcome} ${assertion.expectedEvidence}`
  if ((criterion.level === 'integration' || criterion.level === 'delivery') &&
    /(?:浏览器|browser|Web\s*UI|刷新页面|页面刷新|重新打开页面|(?:重启|重新启动|restart)[^。；;]{0,30}打开页面|(?:refresh|reload)\s+(?:the\s+)?page)/iu.test(observed))
    return { family: 'browser_ui', ruleId: 'browser-integration-surface-v1',
      reason: 'Explicit browser interaction requires a browser trace; a scope manifest or HTTP read cannot replace it.' }
  if (criterion.level === 'delivery' &&
    (/(?:干净|全新|fresh|clean)[^，。；;]{0,24}(?:环境|安装|依赖|install)/iu.test(observed) ||
      /(?:没有|不配置|不需要|无需|无须|不依赖|无|without|no\s+)[^，。；;]{0,24}(?:第三方|云服务|Docker|外部|external|cloud)/iu.test(observed)) &&
    /(?:操作|运行|启动|安装|访问|请求|执行|install|run|start|operate)/iu.test(observed))
    return { family: 'external_platform', ruleId: 'delivery-environment-scenario-v1',
      reason: 'A clean or isolated environment and its actual behavior require external execution evidence.' }
  if (isDeliveryScopeClaim(assertion, criterion)) return { family: 'filesystem', ruleId: 'delivery-scope-review-v2',
    reason: 'Negative delivery scope requires a generated manifest and independent review.' }
  if (criterion.level === 'platform' || /小程序|微信|Android|iOS/u.test(observed))
    return { family: 'external_platform', ruleId: 'platform-surface-v1', reason: 'Assertion requires an actual named platform or mini-program interaction.' }
  if (criterion.level === 'ui') {
    if (/桌面|Desktop|Electron/iu.test(observed))
      return { family: 'desktop_ui', ruleId: 'desktop-surface-v1', reason: 'Assertion names a desktop user interface.' }
    return { family: 'browser_ui', ruleId: 'browser-surface-v1', reason: 'UI criterion requires observable browser interaction.' }
  }
  // A local module/test contract is executable evidence, not an inferred HTTP endpoint.
  const localContract = `${observed} ${criterion.description} ${criterion.expectedEvidence} ${input.requirement.statement}`
  if ((criterion.level === 'integration' || criterion.level === 'delivery') &&
    !/(?:https?:\/\/|\bHTTP\b|\b(?:GET|POST|PUT|DELETE)\s+\/|接口|端点)/iu.test(localContract) &&
    (/(?:\b(?:RangeError|TypeError|ES\s+module|node:test)\b|node\s+--test|\.test\.[cm]?[jt]s\b|(?:导出|导入).{0,40}模块|(?:原始|固定)验收文件)/iu.test(localContract) ||
      (/\b[A-Za-z_$][\w$]*\([^()\n]{0,100}\)/u.test(localContract) && /(?:参数|整数|返回|function|returns?)/iu.test(localContract))))
    return { family: 'command', ruleId: 'local-module-test-v1',
      reason: 'Explicit local module or test contract requires an assertion-scoped repository test; no HTTP endpoint is inferred.' }
  if ((criterion.level === 'api' || criterion.level === 'integration') && claimRequirements(assertion).requiresMutation)
    return { family: 'command', ruleId: 'mutation-repository-test-v2', reason: 'Mutation requires an assertion-scoped repository test with action and reread.' }
  if (criterion.level === 'api')
    return { family: 'http_api', ruleId: 'api-level-v1', reason: 'API criterion requires a bound request and response contract.' }
  if (criterion.level === 'unit')
    return { family: 'command', ruleId: 'unit-level-v1', reason: 'Unit criterion needs an exact trusted test command.' }
  if (criterion.level === 'delivery') {
    if (/人工|客户验收|人工确认/u.test(observed))
      return { family: 'human', ruleId: 'explicit-human-v1', reason: 'Assertion explicitly calls for human acceptance.' }
    if (/Git|commit|分支|diff/iu.test(observed))
      return { family: 'git', ruleId: 'delivery-git-v1', reason: 'Delivery assertion names a Git fact.' }
    if (/文件|目录|产物|清单|文档/u.test(observed))
      return { family: 'filesystem', ruleId: 'delivery-file-v1', reason: 'Delivery assertion names an output artifact or document.' }
    if (/启动|运行|进程|端口/u.test(observed))
      return { family: 'process', ruleId: 'delivery-process-v1', reason: 'Delivery assertion names a running process.' }
    if (claimRequirements(assertion).requiresMutation || /(?:执行|测试|tests|初始化|migration|业务流程)/iu.test(observed))
      return { family: 'command', ruleId: 'delivery-scenario-test-v2',
        reason: 'Delivery scenario needs an assertion-scoped repository test at the implementation commit.' }
  }
  return { family: 'http_api', ruleId: 'integration-observation-v1',
    reason: 'Integration outcome needs a concrete interface or state probe; no endpoint is inferred.' }
}

export interface CapabilityResolution {
  capability: CapabilitySupport
  capabilityId: string
  reason: string
  verificationCommand?: string
  contractAssertionId?: string
  family?: CapabilityFamily
  classificationRule?: string
  providerId?: string
  providerVersion?: string
  capabilityVersion?: string
  evidenceType?: string
  availability?: ProviderAvailability
  /** Explicit trusted policy: a missing external dependency may block implementation itself. */
  startPrerequisite?: 'EXECUTION' | 'COMPLETION'
  /** An exact assertion-scoped verifier blueprint, supplied only by a trusted resolver. */
  provisioningVerifier?: BoundVerifier
}
export interface ResolvedCapability extends CapabilityResolution {
  family: CapabilityFamily
  classificationRule: string
  providerId: string
  providerVersion: string
  capabilityVersion: string
  evidenceType: string
  availability: ProviderAvailability
  schemaVersion: 1
}
export type VerificationCapabilityResolver = (input: {
  assertion: AcceptanceAssertion; criterion: AcceptanceCriterion; requirement: RequirementClause
}) => CapabilityResolution

export const conservativeCapabilityResolver: VerificationCapabilityResolver = (input) => {
  const classification = classifyCapability(input)
  const definition = CAPABILITY_REGISTRY[classification.family]
  const capability: CapabilitySupport = definition.availability === 'HUMAN_REQUIRED' ? 'REQUIRES_HUMAN'
    : definition.availability === 'EXTERNAL_ENVIRONMENT' ? 'REQUIRES_EXTERNAL_ENVIRONMENT' : 'UNSUPPORTED'
  const prerequisiteText = `${input.assertion.observableBehavior} ${input.assertion.expectedEvidence} ${input.requirement.statement}`
  const executionPrerequisite = /(?:开发前|开始开发前|实现前|必须先|需先).{0,30}(?:账号|账户|SDK|权限|凭据|密钥|AppID|平台环境)/iu.test(prerequisiteText)
  return { capability, capabilityId: `${definition.providerId}-v${definition.providerVersion}`,
    family: classification.family, classificationRule: classification.ruleId,
    ...(capability === 'REQUIRES_EXTERNAL_ENVIRONMENT' || capability === 'REQUIRES_HUMAN'
      ? { startPrerequisite: executionPrerequisite ? 'EXECUTION' as const : 'COMPLETION' as const } : {}),
    reason: `${classification.reason} ${definition.reason}` }
}

export function resolveCapability(input: Parameters<VerificationCapabilityResolver>[0],
  resolver: VerificationCapabilityResolver): ResolvedCapability {
  const raw = resolver(input)
  const classified = classifyCapability(input)
  const family = raw.family ?? (raw.capability === 'SUPPORTED' && raw.verificationCommand ? 'command'
    : raw.capability === 'REQUIRES_HUMAN' ? 'human' : classified.family)
  const definition = CAPABILITY_REGISTRY[family]
  const providerId = raw.providerId ?? definition?.providerId
  const providerVersion = raw.providerVersion ?? definition?.providerVersion
  const capabilityVersion = raw.capabilityVersion ?? definition?.version
  const evidenceType = raw.evidenceType ?? definition?.evidenceType
  const classificationRule = raw.classificationRule ??
    (family === classified.family ? classified.ruleId : `trusted-override-${family}-v1`)
  if (!definition || !['SUPPORTED', 'UNSUPPORTED', 'REQUIRES_EXTERNAL_ENVIRONMENT', 'REQUIRES_HUMAN'].includes(raw.capability) ||
    !raw.capabilityId?.trim() || !raw.reason?.trim() ||
    raw.reason.length > 1_000 || !/^[A-Za-z][A-Za-z0-9_-]{0,119}$/u.test(raw.capabilityId) ||
    !providerId || !/^[A-Za-z][A-Za-z0-9_-]{0,119}$/u.test(providerId) ||
    !providerVersion || !/^[A-Za-z0-9_.-]{1,64}$/u.test(providerVersion) ||
    !capabilityVersion || !/^[A-Za-z0-9_.-]{1,64}$/u.test(capabilityVersion) ||
    !evidenceType || !/^[a-z][a-z0-9_]{0,79}$/u.test(evidenceType) ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,119}$/u.test(classificationRule) ||
    (raw.availability !== undefined && !['AVAILABLE', 'UNAVAILABLE', 'EXTERNAL_ENVIRONMENT', 'HUMAN_REQUIRED'].includes(raw.availability)) ||
    (raw.startPrerequisite !== undefined && !['EXECUTION', 'COMPLETION'].includes(raw.startPrerequisite)) ||
    (raw.capability === 'SUPPORTED' && (providerId !== definition.providerId || providerVersion !== definition.providerVersion ||
      capabilityVersion !== definition.version || evidenceType !== definition.evidenceType)) ||
    (raw.capability === 'SUPPORTED' && (family !== 'command' || !raw.verificationCommand ||
      raw.contractAssertionId !== input.assertion.id ||
      scopedNodeTestPath(raw.verificationCommand) === undefined ||
      assessVerificationCommand(raw.verificationCommand).status !== 'ALLOWED')) ||
    (raw.capability !== 'SUPPORTED' && raw.verificationCommand !== undefined)) {
    throw new Error('Invalid trusted capability resolution.')
  }
  if (raw.provisioningVerifier !== undefined && (raw.capability !== 'UNSUPPORTED' ||
    raw.provisioningVerifier.assertionId !== input.assertion.id || raw.provisioningVerifier.family !== family ||
    raw.provisioningVerifier.providerId !== providerId || raw.provisioningVerifier.providerVersion !== providerVersion)) {
    throw new Error('Invalid trusted provisioning verifier identity.')
  }
  return { ...raw, family, classificationRule,
    providerId, providerVersion,
    capabilityVersion, evidenceType,
    availability: raw.availability ?? (raw.capability === 'SUPPORTED' ? 'AVAILABLE' : definition.availability),
    schemaVersion: CAPABILITY_SCHEMA_VERSION }
}

export interface CapabilityEvidence {
  id: string
  assertionId: string
  family: CapabilityFamily
  providerId: string
  providerVersion: string
  collector: string
  evidenceType: string
  result: 'OBSERVED' | 'COLLECTION_FAILED'
  facts: Readonly<Record<string, string | number | boolean>>
}

function evidence(assertionId: string, family: CapabilityFamily, collector: string,
  result: CapabilityEvidence['result'], facts: CapabilityEvidence['facts']): CapabilityEvidence {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(assertionId)) throw new Error('Invalid assertion ID.')
  const definition = CAPABILITY_REGISTRY[family]
  const id = createHash('sha256').update(JSON.stringify({ assertionId, family, collector, result,
    providerId: definition.providerId, providerVersion: definition.providerVersion, facts })).digest('hex')
  return { id, assertionId, family, providerId: definition.providerId, providerVersion: definition.providerVersion,
    collector, evidenceType: definition.evidenceType, result, facts }
}

export function verifyCapabilityEvidence(value: CapabilityEvidence): void {
  if (!value || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(value.assertionId) ||
    !Object.hasOwn(CAPABILITY_REGISTRY, value.family)) throw new Error('Invalid capability evidence identity.')
  const expected = evidence(value.assertionId, value.family, value.collector, value.result, value.facts)
  if (JSON.stringify(expected) !== JSON.stringify(value)) throw new Error('Capability evidence integrity mismatch.')
}

/** A generated scope manifest is observation only; independent review decides the absence claim. */
export function collectScopeManifestEvidence(assertionId: string, manifestHash: string,
  trackedArtifactCount: number): CapabilityEvidence {
  if (!/^[a-f0-9]{64}$/u.test(manifestHash) || !Number.isSafeInteger(trackedArtifactCount) || trackedArtifactCount < 0)
    throw new Error('Invalid generated scope manifest.')
  return evidence(assertionId, 'filesystem', CAPABILITY_REGISTRY.filesystem.providerId, 'OBSERVED',
    { manifestHash, trackedArtifactCount, observedMatch: true })
}

/** A mixed scope claim keeps its positive action test and negative scope manifest in one evidence lineage. */
export async function collectScopeReviewEvidence(input: { target: Pick<DeliveryTargetBinding, 'canonicalPath'>;
  assertionId: string; manifestHash: string; trackedArtifactCount: number; command?: string }): Promise<CapabilityEvidence> {
  const manifest = collectScopeManifestEvidence(input.assertionId, input.manifestHash, input.trackedArtifactCount)
  if (!input.command) return manifest
  const executed = await collectCommandEvidence({ target: input.target, assertionId: input.assertionId,
    command: input.command })
  return evidence(input.assertionId, 'filesystem', CAPABILITY_REGISTRY.filesystem.providerId, 'OBSERVED', {
    manifestHash: input.manifestHash, trackedArtifactCount: input.trackedArtifactCount,
    commandEvidenceId: executed.id, commandExitCode: executed.facts.exitCode as number,
    commandStdoutSha256: executed.facts.stdoutSha256 as string,
    commandStderrSha256: executed.facts.stderrSha256 as string,
    observedMatch: executed.result === 'OBSERVED' && executed.facts.observedMatch === true,
  })
}

function scopedPath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..'))
    throw new Error('Evidence path must be a repository-relative path.')
  const absolute = resolve(root, path)
  if (!absolute.startsWith(`${root}${sep}`)) throw new Error('Evidence path escapes the repository.')
  return absolute
}

/** Observations are evidence, never assertion PASS. Symlinks and out-of-scope reads fail closed. */
export async function collectFilesystemEvidence(input: { target: Pick<DeliveryTargetBinding, 'canonicalPath'>;
  assertionId: string; relativePath: string;
  expectation: 'file_exists' | 'file_missing' | 'directory_exists' | 'contains'; contains?: string }): Promise<CapabilityEvidence> {
  const root = await realpath(input.target.canonicalPath)
  if (root !== input.target.canonicalPath) throw new Error('Filesystem target binding changed.')
  const path = scopedPath(root, input.relativePath)
  const parts = relative(root, path).split(sep)
  for (let i = 1; i <= parts.length; i++) {
    const stat = await lstat(join(root, ...parts.slice(0, i))).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (stat?.isSymbolicLink()) throw new Error('Symlink evidence path is forbidden.')
    if (stat === undefined) return evidence(input.assertionId, 'filesystem', 'scoped-filesystem-read', 'OBSERVED',
      { exists: false, expectation: input.expectation, observedMatch: input.expectation === 'file_missing' })
    if (i === parts.length) {
      if (input.expectation === 'contains') {
        if (!stat.isFile() || stat.size > 64_000 || !input.contains || input.contains.length > 1_000)
          throw new Error('Bounded content contract is invalid.')
        const canonical = await realpath(path)
        if (!canonical.startsWith(`${root}${sep}`)) throw new Error('Evidence path escapes the repository.')
        const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        let content: string
        try {
          if ((await file.stat()).size > 64_000) throw new Error('Bounded content contract is invalid.')
          content = await file.readFile('utf8')
        } finally { await file.close() }
        return evidence(input.assertionId, 'filesystem', 'scoped-filesystem-read', 'OBSERVED',
          { exists: true, kind: 'file', bytes: stat.size, sha256: createHash('sha256').update(content).digest('hex'),
            observedMatch: content.includes(input.contains) })
      }
      const kind = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other'
      const observedMatch = input.expectation === 'file_missing' ? false :
        input.expectation === 'file_exists' ? kind === 'file' : kind === 'directory'
      return evidence(input.assertionId, 'filesystem', 'scoped-filesystem-read', 'OBSERVED',
        { exists: true, kind, observedMatch })
    }
  }
  throw new Error('Unreachable evidence path state.')
}

const git = promisify(execFile)
export async function collectGitEvidence(input: { target: Pick<DeliveryTargetBinding, 'canonicalPath' | 'gitRepositoryIdentity'>;
  assertionId: string } & ({ fact: 'clean'; expected: boolean } | { fact: 'branch' | 'head'; expected: string })): Promise<CapabilityEvidence> {
  const root = await realpath(input.target.canonicalPath)
  if (root !== input.target.canonicalPath) throw new Error('Git target binding changed.')
  const top = (await git('git', ['rev-parse', '--show-toplevel'], { cwd: root, timeout: 10_000 })).stdout.trim()
  if (await realpath(top) !== root) throw new Error('Git evidence root must be the bound repository root.')
  const gitDirectory = (await git('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, timeout: 10_000 })).stdout.trim()
  if (await realpath(gitDirectory) !== input.target.gitRepositoryIdentity) throw new Error('Git repository identity changed.')
  const args = input.fact === 'branch' ? ['symbolic-ref', '--quiet', '--short', 'HEAD'] :
    input.fact === 'head' ? ['rev-parse', 'HEAD'] : ['status', '--porcelain=v1', '--untracked-files=all']
  const observed = (await git('git', args, { cwd: root, timeout: 10_000, maxBuffer: 1_000_000 })).stdout.trim()
  const value = input.fact === 'clean' ? observed === '' : observed
  return evidence(input.assertionId, 'git', 'scoped-git-read', 'OBSERVED',
    { fact: input.fact, observed: value, observedMatch: value === input.expected })
}

export async function collectHttpEvidence(input: { assertionId: string; port: number; route: string;
  expectedStatus: number; expectedJsonPointer?: string; expectedJsonValue?: string; timeoutMs?: number }): Promise<CapabilityEvidence> {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535 ||
    !/^\/[A-Za-z0-9/_?.=&%-]{0,500}$/u.test(input.route) || input.route.startsWith('//') || input.route.includes('..') ||
    !Number.isInteger(input.expectedStatus) || input.expectedStatus < 100 || input.expectedStatus > 599)
    throw new Error('Unsafe local HTTP evidence contract.')
  const timeout = Math.min(Math.max(input.timeoutMs ?? 5_000, 100), 10_000)
  const response = await fetch(`http://127.0.0.1:${input.port}${input.route}`, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeout), headers: { Accept: 'application/json, text/plain' },
  })
  const length = Number(response.headers.get('content-length') ?? '0')
  if (length > 64_000) throw new Error('HTTP evidence response exceeds bound.')
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (reader) {
      const item = await reader.read()
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > 64_000) throw new Error('HTTP evidence response exceeds bound.')
      chunks.push(item.value)
    }
  } finally { await reader?.cancel().catch(() => undefined) }
  const body = Buffer.concat(chunks)
  let bodyMatch = true
  if (input.expectedJsonPointer !== undefined) {
    if (!/^\/(?:[^/~]|~[01])+(?:\/(?:[^/~]|~[01])+)*$/u.test(input.expectedJsonPointer) ||
      input.expectedJsonValue === undefined || input.expectedJsonValue.length > 1_000)
      throw new Error('Unsafe HTTP JSON predicate.')
    const decoded: unknown = JSON.parse(body.toString('utf8'))
    const value = input.expectedJsonPointer.slice(1).split('/').map((part) => part.replace(/~1/gu, '/').replace(/~0/gu, '~'))
      .reduce<unknown>((current, key) => current !== null && typeof current === 'object' &&
        Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined, decoded)
    bodyMatch = typeof value === 'string' && value === input.expectedJsonValue
  }
  return evidence(input.assertionId, 'http_api', 'loopback-http-read', 'OBSERVED',
    { status: response.status, bytes, bodySha256: createHash('sha256').update(body).digest('hex'),
      observedMatch: response.status === input.expectedStatus && bodyMatch })
}

/** Executes only a Node entry inside the bound repository. Output is bounded and never implies business PASS. */
export async function collectProcessEvidence(input: { target: Pick<DeliveryTargetBinding, 'canonicalPath'>;
  assertionId: string; relativeEntry: string; expectedExitCode: number; timeoutMs: number }): Promise<CapabilityEvidence> {
  const root = await realpath(input.target.canonicalPath)
  if (root !== input.target.canonicalPath || !/\.(?:mjs|cjs|js)$/u.test(input.relativeEntry) ||
    !Number.isInteger(input.expectedExitCode) || input.expectedExitCode < 0 || input.expectedExitCode > 255 ||
    !Number.isInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 10_000)
    throw new Error('Unsafe owned process contract.')
  const entry = scopedPath(root, input.relativeEntry)
  const parts = relative(root, entry).split(sep)
  for (let index = 1; index <= parts.length; index++) {
    const stat = await lstat(join(root, ...parts.slice(0, index)))
    if (stat.isSymbolicLink() || (index === parts.length && !stat.isFile())) throw new Error('Unsafe process entry.')
  }
  const result = await execFilePromise(process.execPath, [entry], { cwd: root, timeout: input.timeoutMs,
    maxBuffer: 64_000, env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: root } })
  return evidence(input.assertionId, 'process', 'owned-process-observer', 'OBSERVED',
    { exitCode: result.exitCode, stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'),
      stderrSha256: createHash('sha256').update(result.stderr).digest('hex'),
      observedMatch: result.exitCode === input.expectedExitCode })
}

export async function collectCommandEvidence(input: { target: Pick<DeliveryTargetBinding, 'canonicalPath'>;
  assertionId: string; command: string }): Promise<CapabilityEvidence> {
  const root = await realpath(input.target.canonicalPath)
  const relativeEntry = scopedNodeTestPath(input.command)
  if (root !== input.target.canonicalPath || relativeEntry === undefined ||
    assessVerificationCommand(input.command).status !== 'ALLOWED') throw new Error('Unsafe assertion-bound test contract.')
  const entry = scopedPath(root, relativeEntry)
  const parts = relative(root, entry).split(sep)
  for (let index = 1; index <= parts.length; index++) {
    const stat = await lstat(join(root, ...parts.slice(0, index)))
    if (stat.isSymbolicLink() || (index === parts.length && !stat.isFile())) throw new Error('Unsafe assertion-bound test file.')
  }
  const result = await execFilePromise(process.execPath, ['--test', entry], { cwd: root, timeout: 30_000,
    maxBuffer: 64_000, env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: root } })
  return evidence(input.assertionId, 'command', 'existing-guarded-verifier', 'OBSERVED',
    { exitCode: result.exitCode, stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'),
      stderrSha256: createHash('sha256').update(result.stderr).digest('hex'), observedMatch: result.exitCode === 0 })
}

function execFilePromise(file: string, args: string[], options: Parameters<typeof execFile>[2]): Promise<{
  exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => execFile(file, args, options, (error, stdout, stderr) => {
    if (error && ('killed' in error && error.killed || error.message.includes('maxBuffer'))) { reject(error); return }
    resolve({ exitCode: error && 'code' in error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
      stdout: String(stdout), stderr: String(stderr) })
  }))
}

export type CapabilityCollectionRequest =
  | ({ family: 'filesystem' } & Parameters<typeof collectFilesystemEvidence>[0])
  | ({ family: 'git' } & Parameters<typeof collectGitEvidence>[0])
  | ({ family: 'http_api' } & Parameters<typeof collectHttpEvidence>[0])
  | ({ family: 'process' } & Parameters<typeof collectProcessEvidence>[0])
  | ({ family: 'command' } & Parameters<typeof collectCommandEvidence>[0])

/** Fixed provider dispatch. No assertion text is interpreted as a command or probe input. */
export class TrustedCapabilityRegistry {
  definition(family: CapabilityFamily): CapabilityDefinition { return CAPABILITY_REGISTRY[family] }
  async collect(request: CapabilityCollectionRequest): Promise<CapabilityEvidence> {
    switch (request.family) {
      case 'filesystem': return collectFilesystemEvidence(request)
      case 'git': return collectGitEvidence(request)
      case 'http_api': return collectHttpEvidence(request)
      case 'process': return collectProcessEvidence(request)
      case 'command': return collectCommandEvidence(request)
    }
  }
}

export const trustedCapabilityRegistry = new TrustedCapabilityRegistry()

export function capabilityCoverage(bindings: readonly { blocking: boolean; verificationCapability: ResolvedCapability;
  ownership?: 'OWNER' | 'CONTRIBUTES' | 'AMBIGUOUS';
  stagedVerification?: { readiness: string; obligation?: { providerId: string } } }[],
  availabilityProbe?: (providerId: string) => ProviderAvailability) {
  const blocking = bindings.filter((binding) => binding.blocking && binding.ownership !== 'CONTRIBUTES')
  const count = (predicate: (binding: typeof blocking[number]) => boolean): number => blocking.filter(predicate).length
  return { total: blocking.length, classified: count((binding) => Boolean(binding.verificationCapability.classificationRule)),
    trustedProvider: count((binding) => binding.verificationCapability.capability === 'SUPPORTED' ||
      (binding.stagedVerification?.readiness === 'PROVISIONABLE_DURING_EXECUTION' &&
        binding.stagedVerification.obligation?.providerId === binding.verificationCapability.providerId)),
    executableOnCurrentHost: count((binding) => binding.verificationCapability.capability === 'SUPPORTED' &&
      (availabilityProbe?.(binding.verificationCapability.providerId) ?? binding.verificationCapability.availability) === 'AVAILABLE'),
    externalEnvironment: count((binding) => binding.verificationCapability.capability === 'REQUIRES_EXTERNAL_ENVIRONMENT'),
    human: count((binding) => binding.verificationCapability.capability === 'REQUIRES_HUMAN'),
    unsupported: count((binding) => binding.verificationCapability.capability === 'UNSUPPORTED'),
    unresolved: count((binding) => !binding.verificationCapability.classificationRule) }
}
