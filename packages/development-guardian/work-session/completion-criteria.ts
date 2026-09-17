/** Runtime-owned evidence is produced after verification, during finalization. */
export type RuntimeAcceptanceEvidence = 'CHECKPOINT_COMMITTED'

// Match complete assertions, not mentions of Git/checkpoint in business prose.
// These predicates describe a required state; they are never executable commands.
const CHECKPOINT_ASSERTION = /^(?:(?:应当|应该|应|必须|需要|需)\s*)?(?:成功\s*)?(?:生成|创建|提交)\s*Git\s+checkpoint\s*[。.!！]?$/iu
const ENGLISH_CHECKPOINT_ASSERTION = /^(?:(?:successfully\s+)?(?:create|generate|commit)\s+(?:a\s+)?Git\s+checkpoint|(?:a\s+)?Git\s+checkpoint\s+(?:(?:must|should)\s+be\s+|(?:is|was)\s+)?(?:successfully\s+)?(?:created|generated|committed))\s*[.!]?$/iu

export function runtimeAcceptanceEvidence(criterion: string): RuntimeAcceptanceEvidence | undefined {
  const assertion = criterion.trim()
  return CHECKPOINT_ASSERTION.test(assertion) || ENGLISH_CHECKPOINT_ASSERTION.test(assertion)
    ? 'CHECKPOINT_COMMITTED' : undefined
}

/** Only an exact recognized assertion and its typed evidence may be deferred. */
export function isRuntimeAcceptanceBinding(binding: { criterion: string; requiredEvidence: readonly string[] }): boolean {
  const required = runtimeAcceptanceEvidence(binding.criterion)
  return required !== undefined && binding.requiredEvidence.length === 1 && binding.requiredEvidence[0] === required
}

/** Keep finalization evidence out of both executor packets and shell verifiers. */
export function verifierEvidenceFromBindings(bindings: readonly { criterion: string; requiredEvidence: readonly string[] }[]): string[] {
  return bindings.filter((binding) => !isRuntimeAcceptanceBinding(binding)).flatMap((binding) => binding.requiredEvidence)
}
