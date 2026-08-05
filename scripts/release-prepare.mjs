/* global console */
import { inventory, prepareReleasePackage, releaseRoot } from './release-lib.mjs'

const manifest = prepareReleasePackage()
console.log(JSON.stringify({
  directory: 'release-package',
  fileCount: Object.keys(inventory(releaseRoot)).length,
  name: manifest.name,
  status: 'ok',
  version: manifest.version,
}, null, 2))
