/** Deterministic governance rules. No model, process, repository or write capability. */
export const GOVERNANCE_DRIFT = 'GOVERNANCE_DRIFT:'

export function hasGovernanceDrift(findings: readonly string[]): boolean {
  return findings.some((finding) => finding.startsWith(GOVERNANCE_DRIFT))
}

export const GOVERNANCE_ROLES = Object.freeze({
  planner: { proposes: true, approves: false, executes: false },
  auditor: { proposes: false, approves: true, executes: false },
  executor: { proposes: false, approves: false, executes: true },
  adjudicator: { proposes: true, approves: false, executes: false },
})
