# NovaWing Career Release — Nx Phase N0 Inventory

Bounded architecture POC. **Not** a refactor, **not** a source move, **not** a semantic change.

| Field | Value |
| --- | --- |
| Repository | NovaWing |
| Baseline commit | `803f004772175e7fd15526f9b69ebb3c950cf208` (`main`) |
| Working baseline | `803f004` + 4 pre-existing untracked `docs/plan/NovaWing-v0.6-*.md` files (not created or touched by N0) |
| Phase | N0 — project boundary + dependency census only |
| Source moved | **None** |
| Business logic changed | **None** |
| Executed with | Node `v24.21.0` (nvm), npm `11.19.0`, macOS arm64 |

> 2026-10-09 维护说明：当前 AGENTS.md 已改为 Windows `D:/VSCode/obsidian-ai-memory` 与 macOS `/Users/weijianjun/obsidian-ai-memory` 双路径。下面是 **2026-10-07 原始审计当时的不可访问记录**，不是今天的路径规则，原文保留供溯源。
>
> Note on permanent memory: `AGENTS.md` points at `D:/VSCode/obsidian-ai-memory/00-System/AGENT_MEMORY.md`.
> That path is a Windows path and does not exist on this macOS host (checked `/Users/weijianjun/obsidian-ai-memory`,
> `~/Documents/obsidian-ai-memory`, and the repo parent). It was **not read**. Per `AGENTS.md`, current repository
> facts were re-verified from source instead, and they take precedence. No permanent memory was written.

---

## 1. Method

Two independent evidence sources, cross-checked against each other:

1. **Mechanical import census.** A read-only script (`/tmp`-equivalent scratch, `.tmp/n0-census.mjs` and
   `.tmp/n0-census2.mjs`; `.tmp/` is gitignored) parsed every `.ts` and `.mjs` file under `packages/`,
   `tests/`, `scripts/`, `desktop/`, resolved every relative specifier to a real file, and built a
   file-level directed graph. Strongly-connected components were computed with Tarjan's algorithm,
   both at file level (inside `development-guardian`) and at cluster level (whole repo).
2. **Nx project graph.** A minimal Nx configuration was added (section 3) and the graph was generated
   and diffed against the mechanical result.

The Nx `implicitDependencies` edges are **declarative**, derived from the measured imports — see the
caveat in section 3.3.

### 1.1 Repository size (measured)

| Area | Files | LOC |
| --- | ---: | ---: |
| `packages/development-guardian` | 130 | 39,844 |
| `packages/core` | 6 | 784 |
| `packages/sqlite` | 6 | 1,239 |
| `packages/host-snapshot` | 4 | 636 |
| `packages/testing` | 2 | 61 |
| `desktop` (`.mjs`) | 43 | 8,519 |
| `tests` (`.ts`) | 165 | 50,723 |
| **Total source files scanned by `check-boundaries.mjs`** | **411** | — |

`development-guardian` is **93.6 %** of all `packages/` source (39,844 / 42,564 LOC). The
"largest module" premise is confirmed from source, independently of the brief.

---

## 2. Package-level dependency directions (verified)

Derived by resolving every `nova-wing/*` specifier in the repo to its owning project. **There are no
relative cross-package imports** — `scripts/check-boundaries.mjs` already forbids them and no violation exists.

| Project | Root | Depends on | Evidence (import sites) |
| --- | --- | --- | --- |
| `core` | `packages/core` | *(nothing)* | imports only `node:crypto` and own `./domain/*` |
| `sqlite` | `packages/sqlite` | `core` | `src/sqlite-nova-wing-store.ts:4,22`, `src/migrations/index.ts:4`, `src/snapshot/contract.ts:4` |
| `host-snapshot` | `packages/host-snapshot` | `sqlite` | `src/registry.ts:9,10` |
| `testing` | `packages/testing` | `core` | `src/fake-offerflow-host.ts:9` |
| `development-guardian` | `packages/development-guardian` | **no sibling package** | zero `nova-wing/*` matches under `packages/development-guardian/**` |
| `desktop` | `desktop` | `development-guardian` | `main/host.mjs:1`, `main/index.mjs:110`, `main/isolated-fixture.mjs:7` |

This is a clean DAG. Nx reproduces it exactly (section 4).

**Notable and non-obvious finding:** `development-guardian` does not import `nova-wing/core` at all
today. The cognitive layer and the authoritative kernel are already source-independent. Any future
"guardian depends on core" assumption must be verified, not presumed.

**Inbound dependencies of `development-guardian`** (who would break if it moved):

| Caller area | Files |
| --- | ---: |
| `packages/**` (other packages) | 0 |
| `desktop/main` | 3 |
| `desktop/tests` | 6 |
| `scripts/*.mjs` | 18 |
| `tests/*.ts` | 55 |
| **Total** | **82** |

The package is consumed **only** through its single public entry `nova-wing/development-guardian`
(`packages/development-guardian/index.ts`). There are no deep imports, because
`check-boundaries.mjs` forbids `/src/` deep imports and `check-platform-boundaries` +
`platform-boundaries.test.ts` forbid reaching into `packages/**` from `desktop`.

**Consequence for N1:** the package's *external* contract is already narrow and safe. The risk of the
future split is entirely **internal**, not in the 82 callers.

---

## 3. Nx POC — what was actually added

### 3.1 Dependency

`nx@23.2.1`, exact-pinned, added as a root `devDependency` from the npm registry.

```json
"nx": "23.2.1"
```

Constraints respected:
- `check-boundaries.mjs` rejects `file:`, `link:`, `workspace:`, `../` and absolute dependency
  specifiers. A plain registry version satisfies it; a `workspace:` protocol would **not**.
- `nx` declares a guarded `postinstall` (`node -e "try{require('./dist/bin/post-install')}catch(e){}"`)
  which npm 11's install-script allowlist declined to run. It is a best-effort migration/telemetry
  helper; Nx runs correctly without it (verified in section 4).
- No `@nx/js`, `@nx/eslint`, `@nx/workspace` or any Nx plugin was installed. No ESLint was added.

### 3.2 Configuration

`nx.json` (new, repository root) — deliberately minimal:

```json
{
  "$schema": "./node_modules/nx/schemas/nx-schema.json",
  "defaultBase": "main",
  "neverConnectToCloud": true,
  "useDaemonProcess": false,
  "parallel": 1,
  "namedInputs": {
    "default": ["{projectRoot}/**/*"],
    "production": ["default", "!{projectRoot}/**/*.test.*"]
  }
}
```

- `neverConnectToCloud: true` — no Nx Cloud / network egress, no workspace-linking prompt.
- `useDaemonProcess: false` — Nx leaves **no** background daemon behind after the bounded task.
- `parallel: 1` — this repo compiles all packages in one monolithic `tsc -p tsconfig.build.json`
  into a shared `dist/`. Concurrent per-project tasks would race on the same output. This is a
  correctness guard, not a tuning choice.

Six `project.json` files (all new, no source files moved):

| Project | `project.json` | `projectType` | `sourceRoot` | `tags` | `implicitDependencies` |
| --- | --- | --- | --- | --- | --- |
| `core` | `packages/core/project.json` | library | `packages/core/src` | `scope:novawing`, `type:kernel` | `[]` |
| `sqlite` | `packages/sqlite/project.json` | library | `packages/sqlite/src` | `scope:novawing`, `type:adapter` | `["core"]` |
| `host-snapshot` | `packages/host-snapshot/project.json` | library | `packages/host-snapshot/src` | `scope:novawing`, `type:contract` | `["sqlite"]` |
| `testing` | `packages/testing/project.json` | library | `packages/testing/src` | `scope:novawing`, `type:test-support` | `["core"]` |
| `development-guardian` | `packages/development-guardian/project.json` | library | `packages/development-guardian` | `scope:novawing`, `type:cognitive-layer` | `[]` |
| `desktop` | `desktop/project.json` | application | `desktop/main` | `scope:novawing`, `type:host` | `["development-guardian"]` |

**No targets were declared.** This is intentional and is itself a POC finding — see 3.4.

Root `package.json` scripts added:

```json
"nx:projects": "nx show projects",
"nx:graph": "nx graph --file=artifacts/nx-project-graph.json"
```

`.gitignore` gained `.nx/` (Nx workspace cache/data, JSON-only, never committed).

### 3.3 Load-bearing caveat — the graph is declarative, not inferred

With **no Nx plugin installed**, Nx does not parse the repo's imports. The edges above are
`implicitDependencies` that a human wrote after reading the census. Nx will render them, cache
against them and compute `nx affected` from them — **and it will keep rendering them even if the
imports change.** The graph is therefore a *claim*, not a *measurement*.

Options for N1, in order of increasing cost:

1. Keep `implicitDependencies` and add a small guard script that re-derives the edges from source
   and fails on drift. Cheapest, keeps the repo's existing "no plugin" posture, and reuses the
   census logic already written for N0.
2. Add `@nx/js` with the `typescript` plugin so edges are inferred from the `nova-wing/*` path
   aliases in `tsconfig.json`. This genuinely measures imports, but the plugin also infers build
   targets from `package.json`/`tsconfig` files, which would have to be suppressed. Not adopted in
   N0 because it is a larger change than "minimal Nx configuration".

**Recommendation for N1: option 1.** It preserves the existing enforced boundary mechanism and does
not introduce a second, silently-diverging source of truth.

### 3.4 No targets in N0 — and why that matters

`development-guardian`, `core`, `sqlite`, `host-snapshot` and `testing` have genuinely **no
project-scoped command today**. Everything is repo-global:

- `build` → `tsc -p tsconfig.build.json` (compiles `packages/**` together into one `dist/`)
- `typecheck` → `tsc -p tsconfig.json --noEmit` (whole repo)
- `check:boundaries`, `check:platform`, `check:exports`, `check:migration` → repo-wide

Writing `project.json` targets that shell out to these would make `nx run core:build` claim to build
`core` while actually building everything. That would be a false capability, so it was not done.

**This is the clearest answer to "is Nx suitable here?"**: Nx is suitable *today* as a
project-boundary and dependency-graph tool, but it cannot provide per-project targets, caching or
real `affected` task execution until the build is decomposed. That decomposition is N1+ work and
was explicitly out of N0 scope.

**Second finding:** Nx alone does **not** enforce boundaries in this repo. Enforcement lives in
`scripts/check-boundaries.mjs` (411 files, import + SQL + vocabulary rules) and
`scripts/check-platform-boundaries.mjs` (245 files, exact adapter allowlist). Nx's
`@nx/enforce-module-boundaries` rule requires ESLint, which this repo does not have. The `tags`
added above are inert metadata for now. **N0 did not weaken, replace or bypass any existing check.**

---

## 4. Verification — commands actually executed and results

All commands run from the repository root on Node `v24.21.0`, with `NX_DAEMON=false` and
`NX_NO_CLOUD=true`.

### 4.1 Pre-change baseline (recorded before any edit)

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS (clean, no output) |
| `npm run check:boundaries` | PASS — `{"checkedSourceFiles":411,...,"status":"ok"}` |
| `npm run check:platform` | PASS — `Platform boundaries PASS: 245 common/adapter source files` |

### 4.2 `npx nx show projects`

```
development-guardian
host-snapshot
testing
sqlite
core
desktop
```

**Exactly the six required projects.** No extra project was inferred (in particular the root
`package.json` did *not* become a project, because no `package-json` plugin is active).

Also confirmed: `npx nx --version` → `Local: v23.2.1`, `Global: Not found`.

### 4.3 Nx project graph generation — SUCCESS

```
npx nx graph --file=artifacts/nx-project-graph.json
→ JSON output created in /Users/weijianjun/nova-wing/artifacts
→ 3793 bytes
```

Graph contents (nodes and edges, read back from the JSON):

```
nodes: core, desktop, development-guardian, host-snapshot, sqlite, testing
edges:
  host-snapshot -> sqlite
  testing       -> core
  sqlite        -> core
  desktop       -> development-guardian
```

6 nodes, 4 edges, acyclic. **The Nx graph is identical to the mechanically measured import graph in
section 2.** No cycles, no missing edge, no phantom edge.

### 4.4 Post-change checks

| Command | Result | vs baseline |
| --- | --- | --- |
| `npm run typecheck` | PASS | identical |
| `npm run check:boundaries` | PASS — `checkedSourceFiles: 411` | **identical count** |
| `npm run check:platform` | PASS — `245 common/adapter source files` | **identical count** |
| `npm run check` | **PASS**, exit code 0 — see §10 | — |
| `git diff --check` | **PASS**, exit code 0 — see §10 | — |

The file counts are unchanged (411 / 245), confirming that Nx's `nx.json`, the six `project.json`
files and the `.nx/` cache directory introduced **zero** new source files into either boundary
scanner. `.nx/` was verified to contain only `.json`/`.nxt`/`.hash` artifacts — no `.js`/`.ts` — so
`check-platform-boundaries.mjs`, which reads only `.ts|.mjs|.cjs|.js` and already skips `.tmp`,
`docs`, `artifacts`, `dist`, `node_modules`, is unaffected.

### 4.5 Full `npm run check` and `git diff --check`

`npm run check` = `typecheck && test && check:unused && check:migration && check:exports &&
check:boundaries && check:platform && check:desktop`. Result recorded at the end of this document
(section 10) after the run completed.

---

## 5. `development-guardian` dependency census

### 5.1 Cluster inventory

Clusters are the natural sub-modules the brief named, plus the package root. 130 files, 39,844 LOC.

| Cluster | Path | Files | LOC | External npm deps |
| --- | --- | ---: | ---: | --- |
| `work-session/runtime` | `work-session/*.ts` | 52 | 16,048 | `@mastra/core`, `@mastra/core/workflows`, `@mastra/libsql`, `libsql`, `nodemailer`, `zod` |
| `work-session/launchpad` | `work-session/launchpad/` | 13 | 6,384 | `@openai/codex-sdk` |
| `work-session/control-ui` | `work-session/control-ui/` | 7 | 4,790 | *(none — `node:*` only)* |
| `delivery` | `delivery/` | 9 | 3,191 | `zod` |
| `executors/router` | `executor-router.ts`, `*-executor.ts`, `coding-executor-config.ts`, `codex-workspace-tools.ts`, `delegate-transport.ts`, `shell-contract.ts` | 8 | 3,026 | `@modelcontextprotocol/sdk` (3 subpaths), `@openai/codex-sdk`, `zod` |
| `guardian-root` | remaining root `*.ts` | 14 | 2,985 | *(none — `node:*` only)* |
| `platform` | `platform/` | 14 | 1,537 | *(none — `node:*` only)* |
| `planning` | `planning/` | 8 | 1,500 | `zod` |
| `runtime-config` | `runtime-config/` | 5 | 383 | `zod` |
| **Total** | | **130** | **39,844** | |

### 5.2 Outbound dependencies (guardian → outside)

- **To sibling NovaWing packages: none.** Zero imports of `nova-wing/core`, `sqlite`, `testing` or
  `host-snapshot`.
- **To the outside world: only the table above** — 5 external package families across 130 files.
  `platform`, `guardian-root` and `work-session/control-ui` are **pure `node:*`**, which makes them
  the lowest-risk extraction candidates on the dependency axis.

### 5.3 Inbound dependencies (outside → guardian)

82 files, all through `nova-wing/development-guardian`:
`tests` 55, `scripts` 18, `desktop/tests` 6, `desktop/main` 3, other `packages` **0**.

### 5.4 Cross-cluster edge matrix (measured, edge counts)

```
delivery                  -> planning 11 | work-session/runtime 14 | guardian-root 8 | executors/router 1
executors/router          -> guardian-root 17 | platform 13 | work-session/runtime 7
guardian-root             -> planning 7 | delivery 6 | executors/router 6 | platform 9 | work-session/runtime 3
planning                  -> work-session/launchpad 2
platform                  -> work-session/runtime 3 | work-session/launchpad 1
runtime-config            -> executors/router 2 | work-session/runtime 1
work-session/control-ui   -> work-session/runtime 32 | guardian-root 2 | platform 1 | launchpad 1
work-session/launchpad    -> work-session/runtime 22 | platform 8 | planning 6 | executors/router 6 | delivery 4 | guardian-root 4 | control-ui 1
work-session/runtime      -> guardian-root 32 | platform 21 | executors/router 20 | launchpad 13 | control-ui 4 | runtime-config 2 | delivery 1
```

`guardian-root` and `work-session/runtime` are the two hubs. Every cluster except
`runtime-config` (leaf-ish) participates in at least one cycle.

### 5.5 Dependency cycles — measured

**Cluster level: one giant SCC covering 9 of 9 guardian clusters.** Every cluster is mutually
reachable from every other. There is no topologically clean split available today.

**File level: 5 strongly-connected components, 33 files total.**

| # | Size | Files |
| --- | ---: | --- |
| 1 | 22 | `claude-code-executor.ts`, `codex-executor.ts`, `codex-workspace-tools.ts`, `delivery/capability-layer.ts`, `delivery/runtime-plan.ts`, `delivery/staged-verification.ts`, `delivery/verification-blueprint.ts`, `verification-evidence.ts`, `work-session/autonomous-diagnosis.ts`, `work-session/failure-classification.ts`, `work-session/git-checkpoint.ts`, `work-session/launchpad/repair-model.ts`, `work-session/model.ts`, `work-session/owned-checkpoint.ts`, `work-session/reconciliation.ts`, `work-session/risk-evidence.ts`, `work-session/task-controller.ts`, `work-session/task-observability.ts`, `work-session/task-retry.ts`, `work-session/task-runner.ts`, `work-session/task-state-v2.ts`, `work-session/verification-planner.ts` |
| 2 | 4 | `work-session/control-ui/{activity-projection,events,runtime-overview,task-eta}.ts` |
| 3 | 3 | `work-session/{direct-path,reviewer-runtime,v2-controller-task-runner}.ts` |
| 4 | 2 | `executor-router.ts` ↔ `work-session/coding-execution-store.ts` |
| 5 | 2 | `work-session/launchpad/{server,view}.ts` |

**Mutual cluster pairs (both directions exist):**

| Pair | A→B / B→A edges |
| --- | --- |
| `delivery` ↔ `guardian-root` | 8 / 6 |
| `delivery` ↔ `work-session/runtime` | 14 / 1 |
| `executors/router` ↔ `guardian-root` | 17 / 6 |
| `executors/router` ↔ `work-session/runtime` | 7 / 20 |
| `guardian-root` ↔ `work-session/runtime` | 3 / 32 |
| `planning` ↔ `work-session/launchpad` | 2 / 6 |
| `platform` ↔ `work-session/launchpad` | 1 / 8 |
| `platform` ↔ `work-session/runtime` | 3 / 21 |

### 5.6 The `delivery ↔ work-session` cycle, in detail

The brief's architectural hint was that `delivery/service.ts` depends on `work-session`. **Confirmed
from source — and it is worse than "service.ts alone".** All 14 forward edges:

```
delivery/runtime-adapter.ts  -> work-session/owned-checkpoint.ts        checkpointOwnedImplementation
delivery/runtime-adapter.ts  -> work-session/risk-evidence.ts           completionGate, assessRisk, reviewSatisfied
delivery/runtime-adapter.ts  -> work-session/v2-controller-task-runner.ts  V2ActionDispatcher (type)
delivery/runtime-adapter.ts  -> work-session/verification-planner.ts    verificationPlanFingerprintValid
delivery/runtime-plan.ts     -> work-session/model.ts                   WorkSessionDefinition (type)
delivery/runtime-plan.ts     -> work-session/verification-planner.ts    planVerification
delivery/service.ts          -> work-session/operator-session.ts        isOperatorSession
delivery/service.ts          -> work-session/model.ts                   WorkSessionDefinition (type)
delivery/service.ts          -> work-session/risk-evidence.ts           completionGate, assessRisk, reviewSatisfied
delivery/service.ts          -> work-session/task-controller.ts         TaskController
delivery/service.ts          -> work-session/task-state-v2.ts           loadTaskStateV2, TaskStateV2
delivery/service.ts          -> work-session/verification-planner.ts    verificationPlanFingerprintValid
delivery/task-retry-binding.ts -> work-session/model.ts                 WorkSessionDefinition (type)
delivery/task-retry-binding.ts -> work-session/task-retry.ts            (retry binding)
```

The single **back edge** that closes the cycle:

```
work-session/risk-evidence.ts -> delivery/staged-verification.ts
    taskCompletionGate, CompletionBinding, VerificationBindingTransition,
    AssertionCompletionEvidence, VerificationReadiness, ...
```

`delivery/service.ts` also depends on `planning/freeze.ts`, `planning/model.ts` and the root
`verification-command-policy.ts`, and reaches `executors/router` via
`delivery/verification-blueprint-planner.ts -> deepseek-executor.ts`.

**Interpretation.** `delivery` imports *implementation* from `work-session` (it drives
`TaskController`, loads `TaskStateV2`, reads checkpoint state) while `work-session/risk-evidence.ts`
imports *policy* back from `delivery` (`taskCompletionGate`). This is not a layering inversion that
can be fixed by moving one file; it is a genuine mutual dependency between the delivery obligation
model and the work-session completion gate. **The admission / verification / assertion / evidence
semantics live exactly on this seam**, which N0 is forbidden to touch.

### 5.7 Composition roots

Ranked by number of distinct outbound clusters. These are the files that would have to be split,
inverted or left in a "glue" package for any boundary to hold.

| Rank | File | LOC | Outbound clusters | Outbound targets |
| ---: | --- | ---: | ---: | --- |
| 1 | `work-session/launchpad/server.ts` | 2,888 | **7** | delivery, executors/router, guardian-root, planning, platform, control-ui, runtime |
| 2 | `work-session/production.ts` | 1,119 | **6** | executors/router, guardian-root, platform, runtime-config, control-ui, launchpad |
| 3 | `packages/development-guardian/index.ts` | 147 | 5 | delivery, executors/router, planning, platform, runtime |
| 4 | `claude-code-executor.ts` | 1,709 | 3 | guardian-root, platform, runtime |
| 5 | `codex-executor.ts` | 359 | 3 | guardian-root, platform, runtime |
| 6 | `delivery/runtime-plan.ts` | 517 | 3 | guardian-root, planning, runtime |
| 7 | `delivery/service.ts` | 803 | 3 | guardian-root, planning, runtime |
| 8 | `executor-router.ts` | 316 | 3 | guardian-root, platform, runtime |
| 9 | `verification-evidence.ts` | 260 | 3 | executors/router, platform, runtime |
| 10 | `work-session/owned-checkpoint.ts` | 116 | 3 | executors/router, guardian-root, platform |

Two distinct kinds of composition root:

- **Package entry** — `index.ts` (5 clusters) is the *public* composition root. It is a pure
  re-export barrel, so it is cheap to repoint in N1.
- **Runtime wiring** — `work-session/production.ts` (1,119 LOC, 6 clusters) and
  `work-session/launchpad/server.ts` (7 clusters) are the *real* composition roots. They construct
  executors, the runtime, the reviewer registry, the control UI, the notifier stack and the
  Launchpad HTTP server in one place. **These two files, not `index.ts`, are what will actually
  resist the split.**

### 5.8 Concrete blockers to independent extraction

Per candidate, the specific edges that must be resolved first:

| Candidate | Size | Blockers |
| --- | --- | --- |
| `platform` | 14 files / 1,537 LOC | `platform/windows-task-run-notifier.ts` → `work-session/task-run-analytics.ts` (`formatDurationZh`) **and** → `work-session/notifier.ts` (values); `platform/windows-repair-notifier.ts` → type `RepairErrorCode` from `work-session/launchpad/repair.ts`; `platform/windows-runtime-repair-notifier.ts` → type `RuntimeRepairOutcome` from `work-session/runtime-repair.ts`. **3 of 14 platform files are Windows notification adapters that depend on work-session types/value helpers.** |
| `runtime-config` | 5 files / 383 LOC | `runtime-config/contract.ts` and `model-policy.ts` → `coding-executor-config.ts` (in `executors/router`); `resolver.ts` → `work-session/coding-execution-store.ts` (`defaultCodingExecutionStorePath`). Smallest cluster, but its only 3 outbound edges all leave the cluster. |
| `planning` | 8 files / 1,500 LOC | `planning/provider.ts` and `planning/semantic-reviewer.ts` → `work-session/launchpad/repair-model.ts` (`createCodexRepairModelRunner`, `RepairModelRunner`). Planning's model providers are built on the launchpad's Codex repair runner. |
| `delivery` | 9 files / 3,191 LOC | Everything in 5.6: 14 edges into `work-session/runtime` (incl. `TaskController`, `TaskStateV2`, `planVerification`), 11 into `planning/freeze`+`model`, 8 into `guardian-root` (`verification-command-policy.ts`, `model.ts`, `workspace-scope.ts`), 1 into `executors/router`, plus the `risk-evidence.ts` back edge. |
| `work-session/control-ui` | 7 files / 4,790 LOC | 32 edges into `work-session/runtime` and an internal 4-file SCC. It is a *view* layer over runtime state; extracting it means extracting a read model. |
| `work-session/launchpad` | 13 files / 6,384 LOC | 22 edges into runtime, plus 6 into `planning`, 6 into `executors/router`, 4 into `delivery`, 8 into `platform`. It is a composition root, not a leaf. |
| `executors/router` | 8 files / 3,026 LOC | 17 edges into `guardian-root`, 13 into `platform`, 7 into `work-session/runtime`. `executor-router.ts` ↔ `work-session/coding-execution-store.ts` is a 2-file SCC: the execution store is owned by work-session but used by the router, and the store imports the router's event types. |

**Every one of the seven candidates named in the brief has at least one outbound edge that leaves
the candidate and lands in `work-session/runtime` or `guardian-root`.** There is no
extract-without-edit candidate today.

---

## 6. Suggested next-phase (N1) package boundaries

Ordered by risk-adjusted value. **A boundary is only proposed where the census supports it.**

### Tier 1 — extractable with type-only or zero-edge surgery (low risk)

1. **`@novawing/runtime-config`** — 5 files, 383 LOC, only `zod` external.
   Required fixes: move the `coding-executor-config.ts` contract it consumes (or invert it so
   `runtime-config` owns the config contract and `executors/router` consumes it); replace
   `resolver.ts -> work-session/coding-execution-store.ts` with an injected path provider.
   *Payoff:* removes one cluster from the monolith at very low cost; proves the split mechanics.

2. **`@novawing/platform`** — 14 files, 1,537 LOC, **zero external npm deps**, already governed by an
   exact adapter allowlist in `check-platform-boundaries.mjs`.
   Required fixes: relocate the three Windows notifier adapters
   (`windows-task-run-notifier.ts`, `windows-repair-notifier.ts`,
   `windows-runtime-repair-notifier.ts`) out of `platform` into a notifier-facing package, or invert
   them behind an interface declared in `platform`. Note `check-platform-boundaries.mjs`'s
   `platformAdapters` allowlist keys are **path-based** and would need updating in the same commit.
   *Payoff:* the single best-value extraction — pure `node:*`, low LOC, an existing guard.

### Tier 2 — extractable after inverting one shared contract (medium risk)

3. **`@novawing/planning`** — 8 files, 1,500 LOC, `zod` only.
   Required fix: break `planning/{provider,semantic-reviewer}.ts -> launchpad/repair-model.ts` by
   declaring a `PlanningModelRunner` port in `planning` and binding it to the Codex repair runner
   from the composition root. Note `index.ts` already re-exports the whole `planning` surface, so the
   public contract is ready.

4. **`@novawing/delivery`** — 9 files, 3,191 LOC.
   Required fix: invert `work-session/risk-evidence.ts -> delivery/staged-verification.ts`. The
   completion-gate policy must move *below* both, into a shared contract package that neither owns.
   **This touches admission / verification / assertion / evidence semantics — must be an explicitly
   authorized N1 item with its own verification, not a side effect of a move.**

### Tier 3 — defer (high risk, no clean seam yet)

5. **`@novawing/executors`** — 8 files, 3,026 LOC. Blocked by the `executor-router` ↔
   `coding-execution-store` SCC and 7 edges into `work-session/runtime`.
6. **`@novawing/work-session`** — 72 files, 27,222 LOC across three clusters. This is the core of the
   monolith and should be the *last* thing split, not the first.
7. **`@novawing/control-ui`** — depends on a 32-edge read model of `work-session/runtime`; there is no
   standalone contract to extract yet.

### Structural recommendation

Do **not** attempt a 7-way split. The census shows one large SCC spanning all seven. The defensible
N1 sequence is:

1. Extract Tier 1 (`runtime-config`, `platform`) — proves the mechanics, shrinks the monolith.
2. Add the edge-drift guard from §3.3 so `implicitDependencies` cannot silently diverge.
3. Introduce per-project `tsconfig` + real per-project `build`/`typecheck` targets so Nx caching and
   `affected` become real rather than nominal (this is what makes Nx pay off).
4. Only then attack Tier 2, one contract inversion at a time, each with its own verification run.

---

## 7. What was NOT executed

Explicitly out of scope for N0, and **not done**:

- **No source file was moved, renamed, created inside `packages/**` except `project.json`, or
  deleted.** The six `project.json` files are new configuration, not source.
- **No `development-guardian` sub-package was created.** No `planning`, `delivery`, `platform`,
  `runtime-config`, `executors`, `work-session`, `launchpad` or `control-ui` package exists after N0.
- **No business logic was refactored.** No import statement in `packages/**`, `desktop/**`,
  `tests/**` or `scripts/**` was changed.
- **No admission / verification / assertion / evidence semantics were touched.** The
  `delivery ↔ work-session/risk-evidence` seam identified in §5.6 was **read only**.
- **No database schema change.** No migration file was touched; the expected table set
  `nw_mainline_entries`, `nw_meta`, `nw_proposals` is unchanged and still asserted by
  `check-boundaries.mjs`.
- **Requirement 001 / 002 were not restored.** No file referencing them was modified.
- **No paid model or external agent was called.** No Codex / Claude / DeepSeek / ChatGPT invocation,
  no `guardian:*` script was run. Nx was configured with `neverConnectToCloud: true` and
  `NX_NO_CLOUD=true`; no Nx Cloud connection was attempted.
- **No irrelevant dependency was upgraded.** `typescript` stays `5.9.3`, `electron` stays `44.4.3`,
  `@mastra/core` stays `^1.60.0`, `@openai/codex-sdk` stays `0.157.0`. The only dependency change is
  the addition of `nx@23.2.1`.
- **`nova-wing-desk` was not modified or even read.** It is not in this repository.
- **No boundary check was weakened.** `check-boundaries.mjs` and `check-platform-boundaries.mjs` are
  byte-identical to the baseline; their input file counts are unchanged (411 / 245).
- **No Nx targets, no Nx plugins, no ESLint, no `@nx/*` package, no Nx Cloud.**
- **N1 was not started.** No migration work of any kind.
- **Permanent memory was not updated**, and the Obsidian memory file was not reachable (see the note
  at the top).

One POC-only scratch artifact exists but is gitignored and not a deliverable:
`.tmp/n0-census.mjs`, `.tmp/n0-census2.mjs`, `.tmp/n0-census.out`, `.tmp/npm-cache/`.

---

## 8. Top three most dangerous migration points

### 1. The `work-session/risk-evidence.ts → delivery/staged-verification.ts` back edge

**Why it is dangerous.** It is the *single* edge that closes the `delivery ↔ work-session` cycle, and
it carries the completion gate: `taskCompletionGate`, `CompletionBinding`, `VerificationReadiness`,
`VerificationBindingTransition`, `AssertionCompletionEvidence`. Breaking it means deciding **where
the completion gate lives**, which is a semantic decision about admission and evidence — precisely
what N0 forbids and what N1 must not do implicitly. A naive "move `risk-evidence.ts` into `delivery`"
would drag `completion-criteria.ts` and the `TaskStateV2` completion path with it, silently changing
which module owns the authority to declare a task complete. **The safest form is to invert it behind
an interface that `work-session` declares and `delivery` implements, so that the decision *point*
does not move even though the code does.** Do this one contract at a time, with a dedicated
verification run, and never as a side effect of a directory move.

### 2. `work-session/production.ts` (1,119 LOC, 6 clusters) and `work-session/launchpad/server.ts` (7 clusters)

**Why it is dangerous.** These are the real composition roots. `production.ts` wires the executor
router, the four executor kinds, the runtime-config resolver, the model policy, the reviewer
registry, the control UI controller/server, the SMTP + desktop notifier stack, the analytics store
and the repair stack — in one file. `launchpad/server.ts` touches **all seven** clusters. Splitting
either file requires constructing and threading new dependency-injection seams across module
boundaries. A partial split leaves the package in a state where *both* the old monolith and a new
sub-package exist and can be instantiated, producing **two competing runtimes** — the classic
migration failure. Neither file can be moved; both must be *rewritten*. Budget for that, and stage
it so that the process can only ever construct one runtime.

### 3. The 22-file file-level SCC (the executor ↔ verification ↔ checkpoint knot)

**Why it is dangerous.** It is larger than every other cycle combined (22 of 33 cyclic files) and it
spans four of the seven named clusters at once: `executors/router` (`claude-code-executor.ts`,
`codex-executor.ts`, `codex-workspace-tools.ts`), `delivery` (`capability-layer`, `runtime-plan`,
`staged-verification`, `verification-blueprint`), `work-session` (`task-controller`, `task-state-v2`,
`task-runner`, `verification-planner`, `owned-checkpoint`, `risk-evidence`, `model`,
`task-observability`, `task-retry`, `reconciliation`, `failure-classification`, `git-checkpoint`,
`autonomous-diagnosis`) and `work-session/launchpad` (`repair-model.ts`). It contains
`verification-evidence.ts` and `work-session/verification-planner.ts`, i.e. the **evidence and
verification** plane. Because the SCC is closed, *any* boundary drawn through it will create a
cross-package cycle that the existing `check-boundaries.mjs` cannot see (it only checks
package-level public-export rules, not package→package cycles) and that Nx *will* show as a cycle —
but only after the move, when it is expensive. **Mitigation: before N1, extend the boundary guard to
fail on package-level cycles, so the migration is blocked at commit time rather than discovered in
review.** Also note `claude-code-executor.ts` is 1,709 LOC / 68 KB in a single file — it will need
internal decomposition before it can be moved at all.

---

## 9. Nx suitability verdict

| Question | Verdict |
| --- | --- |
| Can Nx identify the six required projects? | **Yes** — verified, exactly six, no phantoms. |
| Can Nx generate a project graph? | **Yes** — verified, 6 nodes / 4 edges, matching measured imports. |
| Does Nx replace the existing boundary checks? | **No.** Those stay authoritative; Nx adds no enforcement without ESLint. |
| Can Nx give per-project build/test/caching today? | **No.** The build is one monolithic `tsc`; per-project targets would be false. This is the main gap and the main N1 opportunity. |
| Is the Nx graph trustworthy as-is? | **Only if guarded.** It is declarative (`implicitDependencies`), not inferred. Add drift detection before relying on `affected`. |
| Cost | 84 packages added to `node_modules`; 0 source files changed; all checks green. |
| Risk to existing guarantees | **Low.** All boundary/admission/verification checks unchanged and passing at identical file counts. |

**Recommendation:** adopt Nx for project boundaries and the dependency graph, keep
`check-boundaries.mjs` / `check-platform-boundaries.mjs` as the enforcing authority, and treat the
per-project target decomposition — not the package split — as the highest-value next step.

---

## 10. Final verification record

All commands below were executed **after** every N0 change was in place.

**`npm run check`** (full suite: typecheck → test → check:unused → check:migration → check:exports →
check:boundaries → check:platform → check:desktop):

```
> nova-wing@0.1.0 check
> npm run typecheck && npm run test && npm run check:unused && npm run check:migration
  && npm run check:exports && npm run check:boundaries && npm run check:platform && npm run check:desktop

typecheck        PASS  (tsc -p tsconfig.json --noEmit, clean)
test             PASS  tests 1397 | pass 1397 | fail 0 | cancelled 0 | skipped 0 | todo 0
                       duration_ms 156660.595709
                       ISOLATION_CANARY=PASS  ISOLATION_CLEANUP=PASS
check:unused     PASS  (tsc --noUnusedLocals --noUnusedParameters + tsc -p tsconfig.desktop.json)
check:migration  PASS  {"fingerprint":"ea913fb4d017c13247fe96b17b9c0975d03a135294011224342c022862e622de",
                        "schemaVersion":1,
                        "tables":["nw_mainline_entries","nw_meta","nw_proposals"],"status":"ok"}
                       {"analyticsSchemaVersion":2,"analyticsTables":[...5 tables...],"status":"ok"}
check:exports    PASS  {"publicSubpaths":["./core","./development-guardian","./host-snapshot",
                        "./sqlite","./testing"],"rejectedDeepImports":6,"status":"ok"}
check:boundaries PASS  {"checkedSourceFiles":411,"authoritativeTables":["nw_mainline_entries",
                        "nw_meta","nw_proposals"],"dependencySource":"registry-only",
                        "hostSnapshotConcreteHostReferences":0,"status":"ok"}
check:platform   PASS  Platform boundaries PASS: 245 common/adapter source files;
                       exact adapter allowlist enforced.
check:desktop    PASS  tests 194 | pass 194 | fail 0 | cancelled 0 | skipped 0 | todo 0
                       ISOLATION_CANARY=PASS  ISOLATION_CLEANUP=PASS

EXIT CODE: 0
```

**Every stage passed. The DB schema is unchanged** (`nw_mainline_entries`, `nw_meta`, `nw_proposals`,
migration fingerprint `ea913fb4…`), the public export surface is unchanged (5 subpaths, 6 deep
imports correctly rejected), and both boundary scanners report the **same file counts as the
pre-change baseline** (411 / 245).

**`git diff --check`**:

```
$ git diff --check
$ echo $?
0
```

Clean — no whitespace errors, no conflict markers. Tracked diff:
`.gitignore` +3, `package.json` +3, `package-lock.json` +1424/−36.

**No background processes left behind:** `useDaemonProcess: false` was honoured — `pgrep` finds no
Nx daemon and no stray `node … nx` process after the run.

### Actual modified / created files

| File | Status | Change |
| --- | --- | --- |
| `nx.json` | **new** | Minimal Nx workspace config |
| `packages/core/project.json` | **new** | Project declaration |
| `packages/sqlite/project.json` | **new** | Project declaration |
| `packages/host-snapshot/project.json` | **new** | Project declaration |
| `packages/testing/project.json` | **new** | Project declaration |
| `packages/development-guardian/project.json` | **new** | Project declaration |
| `desktop/project.json` | **new** | Project declaration |
| `docs/architecture/career-release-nx-inventory.md` | **new** | This document |
| `package.json` | modified | `devDependencies.nx: "23.2.1"`; scripts `nx:projects`, `nx:graph` |
| `package-lock.json` | modified | Result of the pinned Nx install (84 packages) |
| `.gitignore` | modified | Added `.nx/` |

Not modified: every `.ts` and `.mjs` under `packages/`, `tests/`, `scripts/`, `desktop/`; both
boundary-check scripts; all `tsconfig*.json`; all migration/SQL sources.
