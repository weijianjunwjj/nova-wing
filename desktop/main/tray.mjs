import { fileURLToPath } from 'node:url'
import { resolveTrayImage } from './tray-icon.mjs'

/** A small native entry point; it owns no Runtime or task state machine. */
export function createDesktopTray({ Tray, Menu, nativeImage, showWindow, hideWindow, requestQuit,
  reportFailure = (_error) => {} }) {
  const { image, diagnostics } = resolveTrayImage({
    nativeImage, assetsDirectory: fileURLToPath(new URL('../assets/', import.meta.url)),
  })
  if (image.isEmpty()) throw new Error(`Desktop tray icon could not be loaded: ${diagnostics.asset}`)
  const tray = new Tray(image)
  let menu
  let lastActive
  const invoke = (action) => {
    try { void Promise.resolve(action()).catch(reportFailure) } catch (error) { reportFailure(error) }
  }
  function setActivity(count) {
    if (tray.isDestroyed()) return
    const active = count > 0
    if (menu && lastActive === active) return
    lastActive = active
    menu = Menu.buildFromTemplate([
      { id: 'show', label: '打开 NovaWing', click: () => invoke(showWindow) },
      { id: 'status', label: `当前状态：${active ? '运行中' : '空闲'}`, enabled: false },
      { id: 'hide', label: '隐藏 NovaWing', click: () => invoke(hideWindow) },
      { type: 'separator' },
      { id: 'quit', label: '退出 NovaWing', click: () => invoke(requestQuit) },
    ])
    tray.setContextMenu(menu)
    tray.setToolTip(`NovaWing · ${active ? '运行中' : '空闲'}`)
  }
  try {
    setActivity(0)
    tray.on('click', () => invoke(showWindow))
    return { tray, get menu() { return menu }, setActivity, diagnostics,
      destroy() { if (!tray.isDestroyed()) tray.destroy() },
    }
  } catch (error) {
    tray.destroy()
    throw error
  }
}
