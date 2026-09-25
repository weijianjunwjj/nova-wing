import { buildJevShadowReport, defaultJevShadowDecisionPath, readJevShadowRecords } from '../dist/packages/development-guardian/decision-shadow/index.js'

const path = process.argv[2] || defaultJevShadowDecisionPath({ env: process.env })
const records = await readJevShadowRecords(path)
process.stdout.write(`${JSON.stringify(buildJevShadowReport(records), null, 2)}\n`)
