/**
 * NovaWing v0.2 automated certification — scenario registry.
 */
import type { CertificationScenario } from './scenario.js'
import { s01, s16 } from './scenarios-entry.js'
import { s02, s03, s07, s08, s13 } from './scenarios-core.js'
import { s04, s05, s06, s11, s12, s15 } from './scenarios-risk.js'
import { s09, s10, s14 } from './scenarios-recovery.js'
import { s17, s18, s19, s20, s21, s22, s23, s24, s25, s26, s27, s28, s29, s30 } from './scenarios-contract.js'
import { s31, s32, s33, s34, s35, s36, s37, s38 } from './scenarios-runtime-repair.js'

export const SCENARIOS: readonly CertificationScenario[] = [
  s01, s02, s03, s04, s05, s06, s07, s08,
  s09, s10, s11, s12, s13, s14, s15, s16,
  s17, s18, s19, s20, s21, s22, s23, s24, s25, s26,
  s27, s28, s29, s30,
  s31, s32, s33, s34, s35, s36, s37, s38,
]
