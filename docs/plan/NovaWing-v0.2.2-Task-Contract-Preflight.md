# NovaWing v0.2.2 — Task Contract Preflight v1

## Root cause

The V2 TaskController correctly fails closed when an acceptance criterion has no exact evidence binding. The defect was earlier in the entry path: Launchpad could persist and start a Work Session before proving that the composed Task Contract was mechanically valid. A malformed natural-language binding therefore became a `CONFIGURATION_REQUIRED` runtime suspension and forced the user to relay configuration messages manually.

## Entry architecture

```text
Natural-language Task Brief
→ structured criterion/binding composition
→ repository-aware Task Contract Preflight
→ deterministic mechanical repair
→ verifier classification (TRUSTED / APPROVAL_REQUIRED / INVALID)
→ validation again
→ config persistence and Session creation
```

The text form `criterion => verifier command` exists only at the Launchpad input adapter. It is split at the first delimiter. The preflight, persisted trusted config, TaskStateV2, and Evidence Gate all use structured `AcceptanceEvidenceBinding` objects.

Preflight reads repository facts without executing project code: `package.json` scripts, test configuration, repository file inventory, test paths, source paths, and the local Python virtualenv marker. Placeholder repair selects a command only when repository evidence yields one authoritative test entry. For the Fly-weave layout, `package.json#scripts.test` is authoritative and `<对应测试>` becomes `npm test`; the incompatible `--runInBand` fragment is not retained.

## Safety boundary

Safe automatic repairs are limited to mechanical representation:

- first-delimiter DSL normalization;
- exact/normalized binding identity repair;
- duplicate criterion representation removal;
- duplicate binding/evidence merging;
- placeholder verifier replacement from one repository-authoritative test entry.

Preflight never changes the Goal, weakens or deletes a semantic acceptance criterion, changes allowed/forbidden paths, lowers risk, removes safety constraints, approves a command, or invents business requirements. Semantic ambiguity and commands outside the existing deterministic allowlist return `TASK_CONTRACT_INVALID` before any config or Session exists.

## Failure contract

Launchpad returns HTTP 400 with:

```json
{
  "error": "TASK_CONTRACT_INVALID",
  "issues": [
    {
      "issueCode": "UNRESOLVED_PLACEHOLDER",
      "criterion": "…",
      "binding": { "criterion": "…", "requiredEvidence": ["…"] },
      "reason": "…",
      "attemptedRepair": "…",
      "whyRepairWasUnsafeOrImpossible": "…"
    }
  ]
}
```

The Launchpad UI renders these structured fields. `CONFIGURATION_REQUIRED` remains a valid runtime fail-closed defense for legacy or externally supplied invalid definitions, but the Composer entry path no longer relies on it for contract validation.

## Certification

- S17: Contract placeholder auto-repair
- S18: Unresolvable contract blocked before Session
- S19: Verifier approval discovered before EXECUTE
- S20: Verifier containing `=>` parses correctly
