import { app, BrowserWindow } from 'electron'

// Phase 1 deliberately owns only a window. No production Host is started here.
app.on('window-all-closed', () => app.quit())

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NovaWing Desktop Bootstrap</title>
<style>body{font:18px system-ui,sans-serif;background:#101827;color:#e8eef8;margin:0;padding:64px}h1{font-size:30px}p{line-height:1.6;color:#b8c5d9}</style>
</head><body><h1>NovaWing Desktop Bootstrap</h1>
<p>The desktop shell is ready.</p><p>Close this window to exit.</p></body></html>`

async function createBootstrapWindow() {
  const bootstrapWindow = new BrowserWindow({
    width: 800,
    height: 520,
    title: 'NovaWing Desktop Bootstrap',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition: 'novawing-desktop-bootstrap',
    },
  })

  bootstrapWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  bootstrapWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  bootstrapWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  bootstrapWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  bootstrapWindow.webContents.session.setPermissionCheckHandler(() => false)
  bootstrapWindow.setMenuBarVisibility(false)

  await bootstrapWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
  bootstrapWindow.show()
  return bootstrapWindow
}

// Main module evaluation must finish before Electron can emit ready.
export const bootstrapReady = app.whenReady().then(createBootstrapWindow)
bootstrapReady.catch((error) => {
  console.error('Desktop bootstrap failed:', error)
  process.exitCode = 1
  app.quit()
})
