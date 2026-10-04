/* global console, process */

import {
  createNovaWingLaunchpad,
  defaultTrustedConfigDirectory,
  openLaunchpadInDefaultBrowser,
} from 'nova-wing/development-guardian'

let launchpad

try {
  const configDirectory = defaultTrustedConfigDirectory(process.env)
  launchpad = await createNovaWingLaunchpad({
    configDirectory,
    env: process.env,
    enableProductionPreflight: true,
  })
  await launchpad.start()
  const bootstrapUrl = launchpad.mintBootstrapUrl()
  const browser = await openLaunchpadInDefaultBrowser(bootstrapUrl)

  console.log(`NovaWing Launchpad: ${bootstrapUrl}`)
  if (!browser.opened) console.log('Open the URL above in your browser.')

  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await launchpad?.close()
  }
  process.once('SIGINT', () => { void close() })
  process.once('SIGTERM', () => { void close() })
} catch {
  await launchpad?.close().catch(() => undefined)
  console.error('NovaWing Launchpad 启动失败')
  process.exitCode = 1
}
