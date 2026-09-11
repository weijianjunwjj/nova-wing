import { readFile, writeFile } from 'node:fs/promises'

const runnerPath = new URL('../packages/development-guardian/work-session/v2-controller-task-runner.ts', import.meta.url)
const productionPath = new URL('../packages/development-guardian/work-session/production.ts', import.meta.url)
const indexPath = new URL('../packages/development-guardian/work-session/index.ts', import.meta.url)
const gatePath = new URL('../packages/development-guardian/work-session/learning-gate.ts', import.meta.url)

function replaceExactly(source, before, after, label) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`)
  return source.replace(before, after)
}

let gate = await readFile(gatePath, 'utf8')
const unusedLearningStageHelper = "function withLearningStage(task: TaskStateV2, stage: StrictLearningStage): readonly string[] {\n  return [...withoutLearningStage(task.decisions), `${STAGE_PREFIX}${stage}`]\n}\n\n"
if (gate.includes(unusedLearningStageHelper)) {
  gate = gate.replace(unusedLearningStageHelper, '')
  await writeFile(gatePath, gate)
}

let runner = await readFile(runnerPath, 'utf8')
if (!runner.includes("from './learning-gate.js'")) {
  runner = replaceExactly(
    runner,
    "import { isIndependentReviewerCandidate } from './reviewer-runtime.js'\nimport type { WorkSessionTask } from './model.js'",
    "import { isIndependentReviewerCandidate } from './reviewer-runtime.js'\nimport {\n  acceptLearningExplanation,\n  inspectManualChange,\n  learningHumanRequired,\n  markManualFixRequired,\n  markStrictLearningComplete,\n  parseStrictLearningContract,\n  strictLearningStage,\n  suspendForLearningExplanation,\n} from './learning-gate.js'\nimport type { WorkSessionTask } from './model.js'",
    'learning imports',
  )

  runner = replaceExactly(
    runner,
    "    } catch {\n      return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'RECOVERY_BLOCKED', reason: 'invalid persisted TaskStateV2' } }\n    }\n    // Explicit approval binds the persisted request, never the newly observed workspace.",
    `    } catch {\n      return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'RECOVERY_BLOCKED', reason: 'invalid persisted TaskStateV2' } }\n    }\n\n    // Strict learning is a trusted Task-contract extension. It is handled before\n    // any agent selection or dispatch so explanation/manual phases can never\n    // accidentally re-enter an Executor turn on resume.\n    const learningContract = parseStrictLearningContract(task)\n    if (learningContract.enabled && !learningContract.ok) {\n      const reason = learningContract.issues.map((issue) => issue.reason).join(' ')\n      const blockedState: TaskStateV2 = {\n        ...state, status: 'SUSPENDED', currentAction: 'SUSPEND',\n        blockers: ['LEARNING_CONTRACT_INVALID: ' + reason], updatedAt: new Date().toISOString(),\n      }\n      await context?.persistTaskStateV2?.(blockedState)\n      return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'CONFIGURATION_REQUIRED', reason }, taskStateV2: blockedState }\n    }\n    const strictLearning = learningContract.enabled && learningContract.ok ? learningContract.contract : undefined\n    if (strictLearning !== undefined) {\n      const stage = strictLearningStage(state)\n      if (stage === 'EXPLANATION_REQUIRED') {\n        const decision = typeof resumeData === 'object' && resumeData !== null\n          ? (resumeData as { decision?: unknown }).decision\n          : undefined\n        const explained = acceptLearningExplanation(state, decision)\n        if (explained === undefined) {\n          return { status: 'HUMAN_REQUIRED', humanRequired: learningHumanRequired('EXPLANATION_REQUIRED'), taskStateV2: state }\n        }\n        await context?.persistTaskStateV2?.(explained)\n        return { status: 'HUMAN_REQUIRED', humanRequired: learningHumanRequired('MANUAL_CHANGE_REQUIRED', strictLearning.manualChallenge + ' Manual path: ' + strictLearning.manualPath), taskStateV2: explained }\n      }\n      if (stage === 'MANUAL_CHANGE_REQUIRED' || stage === 'MANUAL_FIX_REQUIRED') {\n        // Repository inspection is deterministic infrastructure, not Executor work.\n        const manual = inspectManualChange({\n          task: state, contract: strictLearning, reality: await this.options.dispatcher.inspectRepository(),\n        })\n        if (!manual.ok) {\n          return { status: 'HUMAN_REQUIRED', humanRequired: learningHumanRequired(stage, manual.reason), taskStateV2: state }\n        }\n        state = manual.task\n        await context?.persistTaskStateV2?.(state)\n      }\n    }\n    // Explicit approval binds the persisted request, never the newly observed workspace.`,
    'learning resume gate',
  )

  runner = replaceExactly(
    runner,
    "      const decision = controller.decide(state, { reconciliationRequired: !reconciliation.reconciled })\n      state = { ...state, currentAction: decision.action,",
    `      const decision = controller.decide(state, { reconciliationRequired: !reconciliation.reconciled })\n      // Once the human has changed code, a failed verifier remains human-owned.\n      // Do not let the normal VERIFY -> EXECUTE repair loop hand that failure to AI.\n      if (\n        strictLearning !== undefined && strictLearningStage(state) === 'MANUAL_VERIFY' &&\n        decision.action === 'EXECUTE' && state.verificationState.results.some((result) => result.status === 'failed')\n      ) {\n        const manualFixState = markManualFixRequired(state)\n        await context?.persistTaskStateV2?.(manualFixState)\n        return { status: 'HUMAN_REQUIRED', humanRequired: learningHumanRequired('MANUAL_FIX_REQUIRED'), taskStateV2: manualFixState }\n      }\n      state = { ...state, currentAction: decision.action,`,
    'manual verification ownership gate',
  )

  runner = replaceExactly(
    runner,
    "      if (decision.action === 'COMPLETE') {\n        const verificationResults = state.verificationState.results",
    `      if (decision.action === 'COMPLETE') {\n        if (strictLearning !== undefined) {\n          if (state.gitState.changedFiles.length > strictLearning.maxFiles) {\n            const reason = 'strict learning scope exceeded: ' + state.gitState.changedFiles.length + ' changed files > ' + strictLearning.maxFiles\n            const blockedState: TaskStateV2 = {\n              ...state, status: 'SUSPENDED', currentAction: 'SUSPEND',\n              blockers: ['LEARNING_SCOPE_EXCEEDED: ' + reason], updatedAt: new Date().toISOString(),\n            }\n            await context?.persistTaskStateV2?.(blockedState)\n            return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'LEARNING_SCOPE_EXCEEDED', reason }, taskStateV2: blockedState }\n          }\n          const stage = strictLearningStage(state)\n          if (stage !== 'MANUAL_VERIFY' && stage !== 'COMPLETE') {\n            // The manual challenge path is reserved for the human. If AI already\n            // touched it, aggregate worktree drift later cannot prove a human edit\n            // occurred on that path, so fail closed and require the task to be split.\n            if (state.gitState.changedFiles.includes(strictLearning.manualPath)) {\n              const reason = 'AI implementation touched reserved manual path: ' + strictLearning.manualPath\n              const blockedState: TaskStateV2 = {\n                ...state, status: 'SUSPENDED', currentAction: 'SUSPEND',\n                blockers: ['LEARNING_MANUAL_PATH_CONTAMINATED: ' + reason], updatedAt: new Date().toISOString(),\n              }\n              await context?.persistTaskStateV2?.(blockedState)\n              return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'LEARNING_MANUAL_PATH_CONTAMINATED', reason }, taskStateV2: blockedState }\n            }\n            const gatedState = suspendForLearningExplanation(state)\n            await context?.persistTaskStateV2?.(gatedState)\n            return { status: 'HUMAN_REQUIRED', humanRequired: learningHumanRequired('EXPLANATION_REQUIRED'), taskStateV2: gatedState }\n          }\n          if (stage === 'MANUAL_VERIFY') {\n            state = markStrictLearningComplete(state)\n            await context?.persistTaskStateV2?.(state)\n          }\n        }\n        const verificationResults = state.verificationState.results`,
    'completion learning gate',
  )
}

if (!runner.includes("from './project-learning-policy.js'")) {
  runner = replaceExactly(
    runner,
    "import type { WorkSessionTask } from './model.js'",
    "import type { WorkSessionTask } from './model.js'\nimport { PROJECT_LEARNING_POLICY_RELATIVE_PATH } from './project-learning-policy.js'",
    'project learning policy import',
  )
}
if (!runner.includes('strictLearningRequired?: boolean')) {
  runner = replaceExactly(
    runner,
    "    controller?: TaskController\n    maxActions?: number",
    "    controller?: TaskController\n    maxActions?: number\n    strictLearningRequired?: boolean",
    'strict learning runner option',
  )
}
if (!runner.includes('LEARNING_CONTRACT_REQUIRED')) {
  runner = replaceExactly(
    runner,
    "    const learningContract = parseStrictLearningContract(task)\n    if (learningContract.enabled && !learningContract.ok) {",
    `    const learningContract = parseStrictLearningContract(task)\n    if (this.options.strictLearningRequired === true && !learningContract.enabled) {\n      const reason = 'repository policy requires strict learning; Task is missing LEARNING_MODE: STRICT and its learning contract'\n      const blockedState: TaskStateV2 = {\n        ...state, status: 'SUSPENDED', currentAction: 'SUSPEND',\n        blockers: ['LEARNING_CONTRACT_REQUIRED: ' + reason], updatedAt: new Date().toISOString(),\n      }\n      await context?.persistTaskStateV2?.(blockedState)\n      return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'CONFIGURATION_REQUIRED', reason }, taskStateV2: blockedState }\n    }\n    if (learningContract.enabled && !learningContract.ok) {`,
    'repository policy requires strict task contract',
  )
}
if (!runner.includes('LEARNING_POLICY_MUTATION_FORBIDDEN')) {
  runner = replaceExactly(
    runner,
    "      const violations = scopeBlockers({ id: task.id, goal: state.goal, state: 'EXECUTING', iteration: 0, maxIterations: 1, allowedPaths: state.permissions.allowedPaths, forbiddenPaths: state.permissions.forbiddenPaths }, state.gitState.changedFiles)",
    `      if (this.options.strictLearningRequired === true && state.gitState.changedFiles.includes(PROJECT_LEARNING_POLICY_RELATIVE_PATH)) {\n        const reason = 'strict learning policy file changed during the Work Session: ' + PROJECT_LEARNING_POLICY_RELATIVE_PATH\n        const blockedState: TaskStateV2 = {\n          ...state, status: 'SUSPENDED', currentAction: 'SUSPEND',\n          blockers: ['LEARNING_POLICY_MUTATION_FORBIDDEN: ' + reason], updatedAt: new Date().toISOString(),\n        }\n        await context?.persistTaskStateV2?.(blockedState)\n        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'LEARNING_POLICY_MUTATION_FORBIDDEN', reason }, taskStateV2: blockedState }\n      }\n      const violations = scopeBlockers({ id: task.id, goal: state.goal, state: 'EXECUTING', iteration: 0, maxIterations: 1, allowedPaths: state.permissions.allowedPaths, forbiddenPaths: state.permissions.forbiddenPaths }, state.gitState.changedFiles)`,
    'protect repository learning policy from task edits',
  )
}
await writeFile(runnerPath, runner)

let production = await readFile(productionPath, 'utf8')
if (!production.includes("from './project-learning-policy.js'")) {
  production = replaceExactly(
    production,
    "import { V2ControllerTaskRunner, type AgentCapabilityProfile, type V2ActionDispatcher } from './v2-controller-task-runner.js'",
    "import { V2ControllerTaskRunner, type AgentCapabilityProfile, type V2ActionDispatcher } from './v2-controller-task-runner.js'\nimport { loadProjectLearningPolicy } from './project-learning-policy.js'",
    'production project policy import',
  )
}
if (!production.includes('strictLearningRequired: projectLearningPolicy')) {
  production = replaceExactly(
    production,
    "        const runner = new V2ControllerTaskRunner({ sessionId: definition.id, branch: definition.branch, agents: v2Agents, dispatcher })",
    "        const projectLearningPolicy = await loadProjectLearningPolicy(definition.targetRepo)\n        const runner = new V2ControllerTaskRunner({ sessionId: definition.id, branch: definition.branch, agents: v2Agents, dispatcher,\n          strictLearningRequired: projectLearningPolicy?.mode === 'strict' })",
    'production strict learning policy wiring',
  )
}
await writeFile(productionPath, production)

let index = await readFile(indexPath, 'utf8')
if (!index.includes("export * from './learning-gate.js'")) {
  index = replaceExactly(
    index,
    "export * from './task-state-v2.js'\nexport * from './task-controller.js'",
    "export * from './task-state-v2.js'\nexport * from './learning-gate.js'\nexport * from './task-controller.js'",
    'learning gate export',
  )
}
if (!index.includes("export * from './project-learning-policy.js'")) {
  index = replaceExactly(
    index,
    "export * from './learning-gate.js'",
    "export * from './learning-gate.js'\nexport * from './project-learning-policy.js'",
    'project learning policy export',
  )
}
await writeFile(indexPath, index)
