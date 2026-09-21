import assert from 'node:assert/strict'
import { once } from 'node:events'
import { app } from 'electron'

/** Actual Control UI, BrowserWindow, Tray handler and notification identity routing. */
export async function windowNavigationRegression(desktop, completed, other) {
  const { windows, notifications, tray, fixture } = desktop
  const beforeRuntime = fixture.getEvidence().runtimeCreateCount
  const beforeTasks = fixture.getEvidence().taskRunCount
  const records = new Map()
  const releases = []
  function track(window) {
    if (records.has(window)) return
    const record = { loads: [], active: 0, maxActive: 0, starts: 0, finishes: window.webContents.getURL() ? 1 : 0, shows: [], frames: [] }
    records.set(window, record)
    const original = window.loadURL
    window.loadURL = async (...args) => {
      record.loads.push(args[0])
      record.maxActive = Math.max(record.maxActive, ++record.active)
      try { return await original.apply(window, args) } finally { record.active-- }
    }
    const started = () => { record.starts++ }
    const finished = () => { record.finishes++ }
    const shown = () => {
      record.shows.push({ loading: window.webContents.isLoadingMainFrame(), finishes: record.finishes })
      // Capture after Chromium's first composited frame, not synchronously from
      // the native show event (the Viz surface may not exist at that instant).
      const frame = window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
        .then(() => window.webContents.capturePage())
        .then((image) => ({ ratio: nonWhiteRatio(image.toBitmap()) }), (error) => ({ error: String(error) }))
      record.frames.push(frame)
    }
    window.webContents.on('did-start-loading', started)
    window.webContents.on('did-finish-load', finished)
    window.on('show', shown)
    releases.push(() => {
      if (window.isDestroyed()) return
      window.loadURL = original
      window.webContents.removeListener('did-start-loading', started)
      window.webContents.removeListener('did-finish-load', finished)
      window.removeListener('show', shown)
    })
  }
  const created = (_event, window) => track(window)
  app.on('browser-window-created', created)
  track(desktop.window)
  const click = (session) => {
    const notification = notifications.snapshot().activeNotifications.find((item) => item.sessionId === session.sessionId)
    assert.ok(notification)
    return notifications.activateNotification(notification.identity)
  }
  function nonWhiteRatio(bitmap) {
    assert.ok(bitmap.length > 0)
    let colored = 0
    let samples = 0
    for (let index = 0; index < bitmap.length; index += 400) {
      samples++
      if (bitmap[index] < 240 || bitmap[index + 1] < 240 || bitmap[index + 2] < 240) colored++
    }
    assert.ok(colored / samples > 0.1, 'Control UI capture must not be a blank white frame')
    return colored / samples
  }
  async function usable(session) {
    const window = desktop.window
    assert.equal(window.isVisible(), true)
    assert.equal(window.webContents.isLoadingMainFrame(), false)
    const page = await window.webContents.executeJavaScript(`(async () => ({
      ready: document.readyState, textLength: document.body.innerText.length,
      sessionId: (await fetch('/api/status').then(r => r.json())).configuredSession.id
    }))()`)
    assert.equal(page.ready, 'complete')
    assert.equal(page.sessionId, session.sessionId)
    assert.ok(page.textLength > 100)
    const frame = await records.get(window).frames.at(-1)
    assert.ok(frame && !frame.error, JSON.stringify(frame))
    return { sessionId: page.sessionId, nonWhiteRatio: frame.ratio }
  }
  try {
    await windows.showSession(completed.sessionId)
    let record = records.get(desktop.window)
    let loads = record.loads.length
    let starts = record.starts
    windows.hideWindow()
    const shown = once(desktop.window, 'show')
    tray.menu.getMenuItemById('show').click()
    await shown
    const A = await usable(completed)
    assert.equal(record.loads.length, loads)
    assert.equal(record.starts, starts)

    windows.hideWindow()
    assert.equal(await click(completed), true)
    const B = await usable(completed)
    assert.equal(record.loads.length, loads)
    assert.equal(record.starts, starts)

    windows.hideWindow()
    assert.equal(await click(other), true)
    const C = await usable(other)
    assert.equal(record.loads.length - loads, 1)

    desktop.window.destroy()
    assert.equal(await click(completed), true)
    record = records.get(desktop.window)
    const D = await usable(completed)
    assert.equal(record.loads.length, 1, 'recreation goes directly to target Control, without Launchpad')

    windows.hideWindow()
    loads = record.loads.length
    const crashed = new Promise((resolve, reject) => {
      desktop.window.webContents.once('render-process-gone', () => {
        Promise.all([click(completed), windows.showWindow()]).then(resolve, reject)
      })
    })
    desktop.window.webContents.forcefullyCrashRenderer()
    await crashed
    await windows.pendingRecovery
    const E = await usable(completed)
    assert.equal(record.loads.length - loads, 1, 'same-session click coalesces with crash recovery')
    for (const item of records.values()) {
      assert.ok(item.maxActive <= 1, 'no concurrent loadURL on a BrowserWindow')
      assert.ok(item.shows.every((show) => !show.loading && show.finishes > 0), 'show follows page completion')
      for (const frame of await Promise.all(item.frames)) assert.ok(!frame.error, JSON.stringify(frame))
    }
    assert.equal(fixture.getEvidence().runtimeCreateCount, beforeRuntime)
    assert.equal(fixture.getEvidence().taskRunCount, beforeTasks)
    return { A: { ...A, loads: 0 }, B: { ...B, loads: 0 }, C: { ...C, loads: 1 },
      D: { ...D, loads: 1 }, E: { ...E, loads: 1 }, maxConcurrentLoads: 1,
      shows: [...records.values()].flatMap((item) => item.shows), runtimeAndTaskCountsUnchanged: true }
  } finally {
    app.removeListener('browser-window-created', created)
    for (const release of releases) release()
  }
}
