import { fileURLToPath } from 'node:url'
import { resolveTrayImage } from './tray-icon.mjs'
import { UPDATER_STATE } from './updater.mjs'

const UNSUPPORTED_UPDATER = Object.freeze({ state: UPDATER_STATE.UNSUPPORTED, candidate: null })

function updaterMenuItem(snapshot, updater, invoke) {
  const version = snapshot?.candidate?.version
  switch (snapshot?.state) {
    case UPDATER_STATE.IDLE:
      return { id: 'update', label: '检查更新', click: () => invoke('check', () => updater.check()) }
    case UPDATER_STATE.CHECKING:
      return { id: 'update', label: '正在检查更新…', enabled: false }
    case UPDATER_STATE.AVAILABLE:
      return { id: 'update', label: `下载 v${version}`, click: () => invoke('download', () => updater.download()) }
    case UPDATER_STATE.DOWNLOADING:
      return { id: 'update', label: `正在下载 v${version}…`, enabled: false }
    case UPDATER_STATE.READY: {
      const confirmation = snapshot?.candidate === null ? null : {
        version: snapshot.candidate.version, identity: snapshot.candidate.identity,
      }
      return { id: 'update', label: `重启并安装 v${version}`,
        click: () => invoke('install', () => updater.requestRestartAndInstall(confirmation)) }
    }
    case UPDATER_STATE.ERROR:
      return { id: 'update', label: '检查更新失败 / 重试', click: () => invoke('check', () => updater.check()) }
    case UPDATER_STATE.UNSUPPORTED:
    default:
      return { id: 'update', label: '更新：当前环境不支持', enabled: false }
  }
}

/** A small native entry point; it owns no Runtime or task state machine. */
export function createDesktopTray({ Tray, Menu, nativeImage, showWindow, hideWindow, requestQuit,
  updater = null, reportFailure = (_error) => {} }) {
  const { image, diagnostics } = resolveTrayImage({
    nativeImage, assetsDirectory: fileURLToPath(new URL('../assets/', import.meta.url)),
  })
  if (image.isEmpty()) throw new Error(`Desktop tray icon could not be loaded: ${diagnostics.asset}`)
  const tray = new Tray(image)
  let menu
  let lastActive
  let updaterSnapshot = updater?.snapshot?.() ?? UNSUPPORTED_UPDATER
  let lastUpdaterKey
  const invoke = (name, action) => {
    try {
      void Promise.resolve(action()).then((result) => {
        if (result?.ok === false && result.state === UPDATER_STATE.ERROR) {
          reportFailure(new Error(`Updater ${name} failed: ${result.reasonCode ?? 'unknown'}`))
        }
      }, reportFailure)
    } catch (error) { reportFailure(error) }
  }
  function rebuild() {
    if (tray.isDestroyed()) return
    const active = lastActive === true
    menu = Menu.buildFromTemplate([
      { id: 'show', label: '打开 NovaWing', click: () => invoke('show', showWindow) },
      { id: 'status', label: `当前状态：${active ? '运行中' : '空闲'}`, enabled: false },
      { id: 'hide', label: '隐藏 NovaWing', click: () => invoke('hide', hideWindow) },
      { type: 'separator' },
      updaterMenuItem(updaterSnapshot, updater, invoke),
      { type: 'separator' },
      { id: 'quit', label: '退出 NovaWing', click: () => invoke('quit', requestQuit) },
    ])
    tray.setContextMenu(menu)
    tray.setToolTip(`NovaWing · ${active ? '运行中' : '空闲'}`)
  }
  function setActivity(count) {
    if (tray.isDestroyed()) return
    const active = count > 0
    if (menu && lastActive === active) return
    lastActive = active
    rebuild()
  }
  function setUpdaterSnapshot(snapshot) {
    if (tray.isDestroyed()) return
    const next = snapshot ?? UNSUPPORTED_UPDATER
    const key = JSON.stringify([next.state, next.reasonCode ?? null,
      next.candidate?.version ?? null, next.candidate?.identity ?? null])
    if (menu && lastUpdaterKey === key) return
    updaterSnapshot = next
    lastUpdaterKey = key
    rebuild()
  }
  try {
    setActivity(0)
    setUpdaterSnapshot(updaterSnapshot)
    tray.on('click', () => invoke('show', showWindow))
    return { tray, get menu() { return menu }, setActivity, setUpdaterSnapshot, diagnostics,
      destroy() { if (!tray.isDestroyed()) tray.destroy() },
    }
  } catch (error) {
    tray.destroy()
    throw error
  }
}
