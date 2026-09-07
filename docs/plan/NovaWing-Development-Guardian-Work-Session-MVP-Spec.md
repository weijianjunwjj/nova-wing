# NovaWing Development Guardian — Work Session MVP Spec

> 状态：Completed / MVP Scope Closed（2026-09-07）
> 日期：2026-08-20
> 基础分支：`feat/development-guardian-mvp`
> 实现分支：`feat/work-session-mvp`
> 目标：把当前“单 Task 自动执行器”升级为可连续自主工作 30–60 分钟、真正需要人时才暂停、并可从断点继续的 Work Session Runtime。

## 1. Product Goal

Work Session MVP 只解决一个核心问题：

> 用户启动一次开发 Session 后，可以离开电脑至少 30 分钟；NovaWing 串行推进多个真实开发 Task，自动 review、execute、verify、checkpoint，并在安全条件满足时继续下一 Task。只有真正需要用户决策、授权、凭证、环境操作或达到硬预算边界时才暂停并通知。用户回来后应从原 checkpoint 继续，而不是重新执行整个任务链。

现有 Development Guardian 保持为“单 Task 执行内核”；Work Session 是它外层的连续工作责任层。

成功体验：

```text
User starts Work Session
  ↓
NovaWing works in background
  ↓
T1 → Guardian → verified → checkpoint
  ↓
T2 → Guardian → verified → checkpoint
  ↓
T3 → recoverable engineering issue → auto revise/resume
  ↓
T3 → verified → checkpoint
  ↓
T4 → real human decision required
  ↓
Work Session suspend + notify
  ↓
User returns and chooses an option
  ↓
Resume from T4 checkpoint
```

## 2. Core Architecture

```text
NovaWing
│
├── Development Guardian                # existing, single-task kernel
│   ├── ChatGPT Web Brain               # unchanged
│   ├── Claude Code Executor            # unchanged
│   └── Deterministic Verification      # unchanged
│
└── Work Session Runtime                # new outer layer
    ├── Task Queue
    ├── Durable Workflow / Snapshot
    ├── Suspend / Resume
    ├── Session Budget
    ├── Human Required Classification
    ├── Safe Git Checkpoint Policy      # later MVP phase
    ├── Notification Adapter            # later MVP phase
    └── Thin Local Control UI           # later MVP phase
```

### 2.1 Architecture Invariants

- Work Session MUST NOT replace `runGuardianTask()`.
- Guardian MUST NOT depend on Mastra.
- Work Session may depend on Guardian through an adapter / injected runner.
- ChatGPT Web remains Brain; GPT API is not introduced.
- Claude Code remains Executor.
- Windows Native + Git Bash-only remains unchanged.
- `cc-auto` stays frozen.
- Work Session is not a generic Agent framework, workflow platform, multi-agent runtime, or IDE.
- Third-party runtime is replaceable infrastructure and MUST NOT define NovaWing core domain contracts.

## 3. Third-party Runtime Decision

MVP uses **Mastra Workflow + persistent storage** only for:

- durable workflow execution;
- snapshot/checkpoint;
- suspend;
- resume;
- process-restart recovery.

MVP explicitly does NOT adopt:

- Mastra Agent;
- Mastra model routing;
- Mastra memory;
- Mastra RAG;
- Mastra tools abstraction;
- Mastra multi-agent patterns;
- Mastra provider system.

Mastra is infrastructure, not NovaWing's Brain or Agent runtime.

Storage for Mastra workflow snapshots MUST remain isolated from NovaWing's existing authoritative `packages/sqlite` tables and migrations.

## 4. Async / Serial Execution Semantics

Work Session execution model is:

> **background asynchronous Session + serial Task queue**

The Session itself runs asynchronously in the background so the caller / future GUI does not block.

Within one target repository, Tasks are strictly serial in MVP:

```text
T1 → await completion
T2 → await completion
T3 → await completion
```

MVP MUST NOT run multiple write Tasks against the same repository in parallel.

Rationale:

- avoid shared worktree contamination;
- keep deterministic verification attributable to one Task;
- keep commit/checkpoint boundaries clear;
- preserve task dependency order;
- avoid multiple Claude sessions racing on the same files.

Parallel read-only research may be considered later, but is not part of this MVP.

## 5. Work Session Time Policy

Default intended user-facing policy:

- Soft Stop: 45 minutes
- Hard Session Boundary: 60 minutes
- Default max Tasks: 5

### 5.1 Soft Stop

At the soft limit, NovaWing MUST stop claiming new Tasks.

If a Task is already in progress, NovaWing may finish that Task, verification, safe checkpoint, and then stop.

### 5.2 Hard Boundary

At the hard boundary, NovaWing MUST NOT start another new Reviewer / Executor / verification iteration.

MVP SHOULD avoid abruptly killing a process in the middle of file mutation solely because the clock crossed the hard boundary. It should stop after the current safe in-flight operation and checkpoint.

Existing per-command watchdog / timeout remains the mechanism for truly stuck processes.

W001 does not need to implement full real-time budget enforcement; it must establish the model and durable state needed for later phases.

## 6. Minimal Domain Contracts

### 6.1 WorkSessionDefinition

Minimum fields:

```text
id
targetRepo
branch
tasks
limits
```

Task MVP shape:

```text
{
  id: string
  goal: string
}
```

Limits MVP shape:

```text
{
  softMinutes: number
  hardMinutes: number
  maxTasks: number
}
```

Cost budget may be added in a later phase; W001 MUST NOT invent fake RMB cost enforcement.

### 6.2 WorkSession State

MVP states:

- READY
- RUNNING
- SUSPENDED
- COMPLETED
- FAILED
- CANCELLED (reserved for explicit user stop; may be implemented after W001)

Minimum durable domain state:

```text
sessionId
state
currentTaskIndex
currentTaskId
completedTaskIds
humanRequired?
createdAt
updatedAt
```

### 6.3 HumanRequired

Minimum initial shape:

```text
{
  category: string
  reason: string
}
```

Do not prematurely create a large approval schema in W001.

### 6.4 WorkSessionTaskRunner

Work Session MUST depend on an injected TaskRunner abstraction rather than directly hard-coding Guardian.

Conceptual interface:

```text
WorkSessionTaskRunner.run(input) -> WorkSessionTaskResult
```

MVP Task result states:

- COMPLETED
- HUMAN_REQUIRED
- FAILED

Guardian integration is a later phase through an adapter.

## 7. Durable Source of Truth

Two concepts must remain separate:

### 7.1 WorkSession Domain State

NovaWing-readable, serializable state used for:

- current task;
- completed tasks;
- session state;
- human-required reason;
- future GUI rendering;
- future email summaries;
- recovery context.

### 7.2 Mastra Workflow Snapshot

Infrastructure state used for:

- execution durability;
- suspend point;
- workflow resume;
- process-restart continuity.

NovaWing MUST NOT hide all business state inside opaque Mastra internals.

Future provider-specific session IDs (for example Claude `session_id` or ChatGPT conversation URL) are recovery optimizations, not the only source of truth.

## 8. Suspend / Resume Semantics

### 8.1 Exact Resume

When durable snapshot, worktree, provider sessions, and repo identity still match:

```text
load Work Session checkpoint
→ validate repo identity
→ restore workflow
→ resume current Task
→ reuse provider sessions where available
```

Previously completed Tasks MUST NOT execute again.

### 8.2 Recovery Resume

If a provider session is unavailable later, NovaWing should still be able to resume from:

- durable WorkSession state;
- Git HEAD / worktree state;
- previous task result/report;
- checkpoint summary.

Provider session continuity is desirable but MUST NOT be the sole durability mechanism.

### 8.3 Resume Input

When suspended for a human decision, resume accepts explicit decision data. The first real GUI will later submit that decision to the Work Session runtime.

## 9. Human-on-Exception Policy

A Work Session MUST NOT equate “any error” with `HUMAN_REQUIRED`.

Brain adapter configuration, transport, protocol, and response failures are represented as
`BRAIN_INFRASTRUCTURE_FAILED`. They suspend the current task at its durable Brain Review
checkpoint without creating a trusted-decision input. Recovery retries the saved review stage;
it MUST NOT restart already-completed Executor work. A requested model remains a hard
configuration requirement, while an unavailable reasoning option may degrade once to the
current UI setting with `actualReasoning=unknown` and a structured warning.

The intended final MVP classification is:

1. `DECISION_REQUIRED` — spec/product/architecture has multiple materially different valid choices and NovaWing cannot safely choose.
2. `PERMISSION_REQUIRED` — task genuinely needs capability outside the approved project profile.
3. `CREDENTIAL_REQUIRED` — API key, login, OAuth, 2FA, CAPTCHA, secret, or human credential is required.
4. `ENVIRONMENT_REQUIRED` — an external device/service/manual GUI action must be performed by the user.
5. `SAFETY_BLOCKED` — destructive or high-risk operation such as force push, main mutation, production migration, destructive data operation.
6. `REPO_DRIFT` — resume checkpoint no longer matches repository/worktree due to external changes.
7. `STALLED` — bounded recovery/review cycles show no meaningful progress.
8. `BUDGET_EXHAUSTED` — hard task/time/cost boundary reached.

The following are NOT automatically `HUMAN_REQUIRED` if NovaWing has a safe deterministic next step:

- test failure;
- typecheck failure;
- build failure;
- normal dependency conflict;
- first max-turn exhaustion;
- Reviewer revise;
- an unauthorized command when an already-authorized equivalent exists;
- transient network failure;
- normal recoverable engineering errors.

This classification is implemented after W001.

## 10. Safe Git Checkpoint Policy

Later MVP phase only.

Auto-commit is allowed only when all are true:

- Guardian final state is COMPLETED;
- deterministic verification passed;
- final Reviewer verdict is done;
- no blockers;
- changed-files scope is valid;
- current branch is an authorized feature branch.

Auto-push is allowed only by explicit Work Session / trusted-project policy.

Never auto-commit or auto-push on:

- HUMAN_REQUIRED;
- FAILED;
- incomplete verification;
- scope violation.

Forbidden in MVP:

- force push;
- push to main;
- reset --hard;
- automatic rebase;
- branch deletion;
- remote mutation.

W001 MUST NOT implement Git finalization.

## 11. Notification Policy

Email is an alert channel, not the primary control plane.

Email is sent only after:

```text
true HUMAN_REQUIRED
→ durable checkpoint succeeds
→ Work Session enters SUSPENDED
→ notification
```

Do not email for:

- ordinary test/build/typecheck failures;
- normal retry/recovery;
- task completion;
- progress updates;
- debug output.

First GUI-driven MVP requires the user to approve/resume inside NovaWing's local GUI. Email does not directly mutate Work Session state in the first version.

Remote email approval is explicitly deferred because it requires a secure public callback/authentication/replay-protection channel.

## 12. Local GUI Scope

GUI is part of the overall Work Session MVP, but NOT W001.

First NovaWing control panel should be a thin local web UI backed by local HTTP + SSE, not a full IDE.

Primary UI shows:

- project / branch;
- session state;
- elapsed / limits;
- task progress;
- current Guardian phase;
- recent events;
- pause / stop-after-task controls;
- HUMAN_REQUIRED decision card;
- resume action.

Raw terminal/log view is a debug fallback, not the main experience.

MVP does not require Electron/Tauri. A browser UI at `127.0.0.1` is sufficient.

## 13. Task Source Policy

MVP uses an explicit ordered Task queue.

NovaWing MUST NOT automatically invent roadmap work.

Initial Task sources may be explicit runtime input. Future adapters may read Markdown tasks or GitHub Issues, but automated task planning is out of scope.

## 14. Work Session State Machine

Outer state machine:

```text
READY
  ↓
RUNNING
  ↓
RUNNING_TASK
  ↓
CHECKPOINTING
  ├─ next task → RUNNING_TASK
  ├─ limits reached → COMPLETED / stopped summary
  └─ true human need → SUSPENDED
                          ↓
                        RESUME
                          ↓
                      RUNNING_TASK

terminal states:
COMPLETED
FAILED
CANCELLED
```

Guardian's existing internal phases/states remain separate and are NOT merged into the Work Session state machine.

## 15. Phased Implementation Plan

### W001 — Durable Work Session Skeleton

Goal:

- introduce minimal Work Session domain model;
- introduce TaskRunner abstraction;
- integrate Mastra durable workflow/snapshot/storage;
- serial Task progression;
- suspend on HUMAN_REQUIRED;
- process recreation + resume;
- prove completed Task is not rerun.

Uses FakeTaskRunner only.

Explicitly does NOT integrate real Guardian.

### W002 — Guardian Adapter + Recoverable Classification

Goal:

- adapt `runGuardianTask()` into WorkSessionTaskRunner;
- preserve existing Guardian behavior;
- classify ordinary/recoverable Guardian stops separately from true human-required stops;
- allow safe revise/resume instead of immediately suspending Work Session.

Target real regression: the existing Fly-Weave T002 permission-denial/max-turn scenario should not automatically wake the user if an authorized equivalent path exists.

### W003 — Real Resume Continuity

Goal:

- persist/reuse ChatGPT conversation context and Claude session ID where safe;
- support exact resume and recovery resume;
- prove an existing partially-completed real task can continue without restarting prior completed work.

Primary real acceptance target: the preserved Fly-Weave T002 worktree/session context.

### W004 — Safe Git Checkpoint + Continuous Tasks

Goal:

- feature-branch-only auto commit/push after true COMPLETED;
- checkpoint commit SHA;
- continue to next Task automatically;
- enforce soft/hard/maxTasks boundaries.

### W005 — Thin Local GUI

Goal:

- start/observe/pause/stop-after-task;
- render task timeline and session state;
- HUMAN_REQUIRED decision UI;
- one-click resume from checkpoint;
- raw logs only as secondary debug view.

### W006 — Notification Adapter

Goal:

- email only for true decision/approval HUMAN_REQUIRED;
- include project, session, completed work, current blocker, recommendation, and resume instructions;
- no completion/progress spam.

## 16. W001 Acceptance Criteria

W001 is accepted only when all are true.

Use a real persistent Mastra + LibSQL-backed integration test, not a fake `suspend()` mock.

Test queue:

```text
T1
T2
T3
```

First runtime instance:

```text
T1 → COMPLETED
T2 → HUMAN_REQUIRED(category=DECISION_REQUIRED, reason="choose database mode")
```

Required assertions before restart:

- session state = SUSPENDED;
- completedTaskIds = [`T1`];
- currentTaskId = `T2`;
- T3 execution count = 0;
- durable workflow state exists in the same persistent storage.

Then fully destroy the first runtime/workflow/Mastra instance and recreate a new runtime using the same DB + session/run identity.

Resume input:

```text
{ decision: "docker" }
```

After resume:

```text
T2 → COMPLETED
T3 → COMPLETED
```

Final assertions:

- session state = COMPLETED;
- completedTaskIds = [`T1`, `T2`, `T3`];
- T1 total execution count = exactly 1;
- T3 runs only after resumed T2 completes.

Additional cases:

### Case B — FAILED

```text
T1 → COMPLETED
T2 → FAILED
```

Expect:

- session FAILED;
- completedTaskIds = [`T1`];
- T3 never executes;
- no automatic resume.

### Case C — First Task Suspends

```text
T1 → HUMAN_REQUIRED
```

Expect:

- completedTaskIds = [];
- currentTaskId = `T1`;
- session SUSPENDED;
- process recreation + resume continues T1, not T2.

## 17. W001 Allowed Changes

Expected additive scope:

- `packages/development-guardian/work-session/**`
- `packages/development-guardian/index.ts`
- Work Session tests under `tests/**`
- `package.json`
- `package-lock.json`
- minimal build/type configuration only if strictly required by the selected stable Mastra API
- this spec only if an implementation-discovered contradiction requires documented correction

Do not modify existing Guardian behavior merely to make W001 easier.

## 18. W001 Forbidden Changes

W001 MUST NOT change or implement:

- `runGuardianTask()` semantics;
- AskBridgeBrain behavior;
- ClaudeCodeExecutor permission/recovery behavior;
- existing deterministic verification policy;
- target-repo Git commit/push;
- GUI / HTTP / SSE;
- email;
- Fly-Weave;
- Task markdown parser;
- GitHub Issues TaskSource;
- cost budget enforcement;
- parallel task execution;
- multi-agent;
- Spec-Kit;
- ESLint;
- cc-auto.

Do not modify `packages/sqlite/**` or existing NovaWing authoritative migrations to store Mastra snapshots.

## 19. Dependency Policy

Before implementation, query current registry versions and use stable releases only.

Expected candidates:

- `@mastra/core`
- `@mastra/libsql`
- `zod` only if required by actual stable API / direct typing

Forbidden:

- alpha / beta / rc dependencies;
- local `file:` / `link:` / `workspace:` dependency additions;
- package lifecycle side effects such as `preinstall`, `install`, `postinstall`, `prepare`, `prepublish`, `prepublishOnly`;
- `npm create mastra` scaffolding.

## 20. Verification Policy

W001 must pass existing NovaWing gates:

```text
npm run typecheck
npm test
npm run check:unused
npm run check:boundaries
git diff --check
npm run check
```

Existing Guardian tests must remain green.

Warnings from third-party dependencies must be distinguished from failures; do not weaken NovaWing verification to silence warnings.

## 21. Architecture Blocker Rule

During W001, ordinary implementation failures are not architecture blockers.

The implementer may declare `ARCHITECTURE_BLOCKER` only if there is concrete evidence that one of these is true:

1. the current stable Mastra API cannot provide durable suspend/resume semantics required by this spec;
2. process recreation cannot resume from persistent snapshot without rerunning completed work;
3. dynamic serial Task progression fundamentally conflicts with the stable workflow model;
4. WorkSession domain state and workflow snapshot cannot be cleanly separated without violating durability;
5. implementation requires breaking existing Guardian boundaries.

When blocked:

- do not switch frameworks autonomously;
- do not redesign Guardian;
- report evidence, failing test/API behavior, and minimal candidate options.

## 22. Model / Cost Strategy for Implementation

Default implementation model:

> Sonnet 5 / Medium

Escalate to Sonnet 5 / High only for a real architecture or durable-state blocker.

Use Opus 5 / High only after the same concrete architecture blocker fails to converge through two Sonnet High attempts; Opus is used for focused diagnosis, not bulk implementation. After diagnosis, execution returns to Sonnet.

Quality is enforced primarily through this spec, deterministic integration tests, existing checks, and remote review—not by defaulting to the most expensive model.

## 23. Overall MVP Definition of Done

The complete Work Session MVP is done only when a real project session demonstrates:

1. user starts one Work Session and leaves the computer for at least 30 minutes;
2. Tasks execute serially in the background;
3. 2–5 real Tasks can complete without manual GPT ↔ Claude copying;
4. each completed Task is deterministically verified and safely checkpointed;
5. recoverable engineering problems do not wake the user;
6. true HUMAN_REQUIRED safely suspends and produces actionable notification;
7. user can return to the local GUI and resume from the original checkpoint;
8. previously completed Tasks are not rerun;
9. feature-branch commits already checkpointed remain durable across later failures;
10. no generic Agent platform / multi-agent / workflow-editor scope creep is introduced.

Primary real-world acceptance sequence after W001–W006:

```text
Fly-Weave existing T002 partial state
→ resume rather than restart
→ T002 verified + checkpointed
→ T003 completed + checkpointed
→ T004 completed or safely suspended
→ true HUMAN_REQUIRED notification if needed
→ GUI decision
→ resume from checkpoint
```

## 24. Change Control

This document is the scope authority for `feat/work-session-mvp`.

If implementation discovers a requirement outside this spec:

1. stop that scope expansion;
2. report why the current phase cannot proceed without it;
3. state complexity/risk;
4. update this spec only after explicit approval.

No “while we are here” features.

Development sequence is fixed:

```text
W001 durable skeleton
→ W002 Guardian adapter/recovery classification
→ W003 real resume
→ W004 safe Git checkpoint/continuous tasks
→ W005 local GUI
→ W006 email notification
→ real Fly-Weave Work Session acceptance
```
