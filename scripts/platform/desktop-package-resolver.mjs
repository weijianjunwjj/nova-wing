/**
 * The single place that selects a desktop packaging adapter.
 *
 * Both adapters expose the same contract, so shared smoke code never assembles a
 * platform bundle layout itself:
 *   unpacked                 staged/unpacked output directory
 *   packagedAppRoot          directory holding the packaged application source
 *   packagedBundleRoot       distributable root (.app bundle, or the unpacked directory)
 *   packagedExecutable(root) executable to launch for a given app root
 *   stagePackagedSmokeCopy(root)  copy the bundle into a disposable root, return its app root
 *   auditPackage(appRoot)    packaged content audit
 *   nativeNotificationGate() 'REQUIRED' when native delivery is a hard gate, otherwise
 *                            a reason string, derived from real bundle signing state.
 */
export async function desktopPackaging() {
  return process.platform === 'win32' ? import('./windows-package.mjs') : import('./macos-package.mjs')
}
