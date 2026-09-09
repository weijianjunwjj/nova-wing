# v0.2 Launchpad production entry repair

## Root cause and boundary

The Launchpad form serializes executor selection but no control-plane field to
`POST /api/session/create`. The strict Composer request parser likewise has no
control-plane field. `launchComposedWorkSession` previously assembled a trusted
config without `session.controlPlane`, and persisted that omission to JSON.
Discovery and launch-time validation preserve the optional field. Production
copies it into `WorkSessionDefinition` and selects `V2ControllerTaskRunner` only
for explicit `v2`; an omitted field selects `GuardianWorkSessionTaskRunner`.
The release production tests supplied `v2` directly, bypassing Composer.

The trusted new-session creation boundary now writes `controlPlane: 'v2'` before
validation and persistence. Browser requests do not choose runtime internals.
Existing config loading and runtime recovery defaults are unchanged: explicit
`v1` and historical omitted values retain Guardian semantics. No migration is
performed. Explicit compatibility remains available through trusted V1 configs.

## Brain availability

Production previously constructed Brain before choosing either runner, and static
dependency preflight required AskBridge for every control plane. Brain construction
now belongs to the V1 branch. Preflight accepts the session control plane: Launchpad
cold start and Composer use V2, existing config start uses its persisted value
(with omitted values treated as V1), and production resume uses the definition.
V2 skips V1 Brain/Bridge probes and reports their availability as UNKNOWN, without
blocking ordinary execution. Shell, Git and executor checks still apply. V1 keeps
its Brain transport/configuration checks. V2 actions requiring unavailable review
or other capabilities retain the existing Controller/dispatcher suspension policy.

## DOGFOOD-001

Quick Fill replaces recognized project, branch, Task ID and policy text fields and
clears unresolved values, including on analysis request failure. It explains the
cleared fields to the user. Model recommendation alone does not change these fields.
The parser itself is unchanged; this is a local form-application repair.

## Regression evidence

- Default Launchpad HTTP request through JSON persistence, reload and production
  composition selects V2, inspects a real Git repository and dispatches Controller
  EXECUTE to a Codex test double with AskBridge unavailable. It pauses after that
  first executor boundary and does not claim live model execution or completion.
- Explicit V1 and omitted legacy configs still construct Guardian and exercise
  its review/executor flow; Launchpad reload leaves historical JSON unchanged.
- Preflight with unavailable AskBridge permits V2 and blocks V1/omitted legacy mode.
- Served browser Quick Fill code replaces values, clears unresolved values and
  preserves form values during model-only advice.

The Composer currently does not author V2 acceptance-evidence bindings. This repair
verifies entry/first dispatch only and does not manufacture bindings or relax the
semantic completion gate. D01 ENOTEMPTY investigation was not resumed.

## Final verification

- Targeted Launchpad, production Guardian and dependency-preflight tests: 64 passed.
- Affected production V2, repository reality, observability and durability integrations: 21 passed.
- `npm test`: 682 passed, 0 failed, 0 skipped.
- `npm run typecheck`, `npm run check:unused`, `npm run check:migration`,
  `npm run check:exports`, `npm run check:boundaries`, `npm run pack:check`,
  and `git diff --check`: passed.
- Pack check initially hit sandbox EPERM writing the user npm cache. It passed
  with `npm_config_cache` redirected to a temporary directory; no dependency
  or lockfile changes were needed.
