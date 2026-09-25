import { buildDecisionShadowReport, defaultDecisionShadowPath, readDecisionShadowRecords } from '../dist/packages/development-guardian/decision-shadow/index.js'

const path = process.argv[2] || defaultDecisionShadowPath({ env: process.env })
const records = await readDecisionShadowRecords(path)
process.stdout.write(`${JSON.stringify(buildDecisionShadowReport(records), null, 2)}\n`)
