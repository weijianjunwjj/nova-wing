/* global console, process */
import { isExactSemVer, readRootManifest } from './release-lib.mjs'

const expectedVersion = process.env.EXPECTED_VERSION
const confirmation = process.env.RELEASE_CONFIRM
if (confirmation !== undefined && confirmation !== 'publish') {
  throw new Error('manual release confirmation must equal publish')
}
if (typeof expectedVersion !== 'string' || !isExactSemVer(expectedVersion)) {
  throw new Error('expected version must be an exact SemVer')
}
if (readRootManifest().version !== expectedVersion) {
  throw new Error('expected version does not match package.json')
}
console.log(JSON.stringify({ status: 'ok', version: expectedVersion }))
