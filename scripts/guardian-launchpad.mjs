/* global console, process */

import {
  createNovaWingLaunchpad,
  defaultTrustedConfigDirectory,
  openLaunchpadInAppMode,
} from 'nova-wing/development-guardian'

let launchpad

try {
  const configDirectory = defaultTrustedConfigDirectory(process.env)
  launchpad = await createNovaWingLaunchpad({
    configDirectory,
    env: process.env,
    enableProductionPreflight: true,
  })
  const address = await launchpad.start()
  const browser = await openLaunchpadInAppMode(address.url)

  if (!browser.opened) {
    console.log('NovaWing Launchpad:')
    console.log(address.url)
  }

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
