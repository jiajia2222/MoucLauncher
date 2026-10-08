import path from 'node:path'
import fs from 'node:fs'
import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from 'electron'
import { EVENTS } from '@shared/ipc'
import { createContainer } from './container'
import { registerIpc } from './ipc'
import { Logger } from './core/log'
import type { Container } from './core/contracts'

let container: Container | undefined
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

const bootstrapLog = new Logger('bootstrap', path.join(app.getPath('userData'), 'logs'))

/** `node scripts/smoke.mjs` sets this; the app must then self-check and exit. */
const SMOKE = process.argv.includes('--smoke-test') || process.env.MoucX_SMOKE === '1'

function smokePass(detail: unknown): void {
  console.log(`SMOKE_OK ${JSON.stringify(detail)}`)
  app.exit(0)
}

function smokeFail(reason: string): void {
  console.log(`SMOKE_FAIL ${reason}`)
  app.exit(1)
}

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

interface WindowBounds {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

function readBounds(): WindowBounds {
  const fallback: WindowBounds = { width: 1280, height: 800, maximized: false }
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Partial<WindowBounds>
    const width = typeof raw.width === 'number' ? Math.min(4096, Math.max(1100, raw.width)) : fallback.width
    const height = typeof raw.height === 'number' ? Math.min(4096, Math.max(700, raw.height)) : fallback.height
    return {
      width,
      height,
      maximized: raw.maximized === true,
      ...(typeof raw.x === 'number' ? { x: raw.x } : {}),
      ...(typeof raw.y === 'number' ? { y: raw.y } : {})
    }
  } catch {
    return fallback
  }
}

function stateFile(): string {
  return path.join(app.getPath('userData'), 'config', 'window.json')
}

function saveBounds(win: BrowserWindow): void {
  try {
    const bounds = win.getBounds()
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ ...bounds, maximized: win.isMaximized() }, null, 2),
      'utf8'
    )
  } catch (error) {
    bootstrapLog.warn(`窗口位置保存失败: ${String(error)}`)
  }
}

function iconPath(): string | undefined {
  const candidates = [
    path.join(app.getAppPath(), 'resources', 'icon.png'),
    path.join(process.resourcesPath ?? '', 'resources', 'icon.png')
  ]
  return candidates.find((candidate) => fs.existsSync(candidate))
}

function createWindow(): BrowserWindow {
  const bounds = readBounds()
  const icon = iconPath()
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    frame: false,
    backgroundColor: '#0f1013',
    title: 'MoucX',
    autoHideMenuBar: true,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.MoucX_DEVTOOLS === '1'
    }
  })

  if (bounds.maximized) win.maximize()

  // electron-vite injects the dev server URL; a packaged build loads the bundled file.
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')).catch((error: unknown) => {
      bootstrapLog.error('渲染页面加载失败', error)
      if (SMOKE) smokeFail(`加载失败 ${String(error)}`)
    })
  }

  win.once('ready-to-show', () => win.show())
  if (SMOKE) {
    // Fail fast in CI instead of burning the harness timeout.
    const smokeDeadline = setTimeout(() => smokeFail('30s 内渲染进程没有完成加载'), 30_000)
    smokeDeadline.unref?.()
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) =>
      smokeFail(`渲染进程加载失败 ${errorCode} ${errorDescription}`)
    )
    win.webContents.once('did-finish-load', () => {
      clearTimeout(smokeDeadline)
      void runSmokeChecks(win)
    })
  }
  win.on('resize', () => saveBounds(win))
  win.on('move', () => saveBounds(win))
  const pushState = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send(EVENTS.windowState, {
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
      alwaysOnTop: win.isAlwaysOnTop()
    })
  }
  win.on('maximize', pushState)
  win.on('unmaximize', pushState)
  win.on('enter-full-screen', pushState)
  win.on('leave-full-screen', pushState)
  win.on('close', (event) => {
    if (quitting) return
    const decision = handleCloseRequest()
    if (decision === 'hide') {
      event.preventDefault()
      win.hide()
      ensureTray()
    } else if (decision === 'ask') {
      event.preventDefault()
      askWhatToDo(win)
    }
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // Nothing may leave our origin, and window.open becomes the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shellOpenExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith(win.webContents.getURL().split('#')[0] ?? '')
    if (!allowed) {
      event.preventDefault()
      bootstrapLog.warn(`拦截导航: ${url}`)
    }
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    bootstrapLog.error(`渲染进程退出 reason=${details.reason} code=${details.exitCode}`)
    if (!win.isDestroyed()) win.webContents.reload()
  })
  win.webContents.on('unresponsive', () => bootstrapLog.error('渲染进程无响应'))

  return win
}

async function shellOpenExternal(url: string): Promise<void> {
  const { shell } = await import('electron')
  await shell.openExternal(url)
}

/* ------------------------------------------------------------------ */
/* close behaviour                                                     */
/* ------------------------------------------------------------------ */

type CloseDecision = 'close' | 'hide' | 'ask'

function runningGameCount(): number {
  return container?.game.running().length ?? 0
}

function activeDownloads(): number {
  const jobs = container?.downloader.jobs() ?? []
  return jobs.filter((job) => job.status === 'running' || job.status === 'queued').length
}

function handleCloseRequest(): CloseDecision {
  if (SMOKE) return 'close'
  if (runningGameCount() > 0 || activeDownloads() > 0) return 'ask'
  const action = container?.settings.get().closeAction ?? 'ask'
  if (action === 'exit') return 'close'
  if (action === 'minimize') return 'hide'
  return 'ask'
}

function askWhatToDo(win: BrowserWindow): void {
  const warnings: string[] = []
  if (runningGameCount() > 0) warnings.push(`仍有 ${runningGameCount()} 个游戏在运行，退出启动器不会关闭游戏窗口。`)
  if (activeDownloads() > 0) warnings.push(`还有 ${activeDownloads()} 个下载任务未完成，未完成的文件会保留以便续传。`)
  const choices = ['最小化到后台', '退出 MoucX', '取消']
  dialog
    .showMessageBox(win, {
      type: 'warning',
      title: '关闭 MoucX',
      message: warnings.length > 0 ? warnings.join('\n') : '确定退出吗？',
      detail: warnings.length > 0 ? '后台模式会保留正在进行的任务。' : undefined,
      buttons: warnings.length > 0 ? [choices[0], choices[1], choices[2]] : [choices[1], choices[2]],
      defaultId: warnings.length > 0 ? 2 : 1,
      cancelId: warnings.length > 0 ? 2 : 1,
      noLink: true
    })
    .then(({ response }) => {
      const index = warnings.length > 0 ? response : response + 1
      if (index === 0) {
        win.hide()
        ensureTray()
        return
      }
      if (index === 1) {
        quitting = true
        app.quit()
      }
    })
    .catch((error: unknown) => bootstrapLog.error('关闭对话框失败', error))
}

function ensureTray(): void {
  if (tray) return
  const icon = iconPath()
  if (!icon) return
  tray = new Tray(nativeImage.createFromPath(icon))
  tray.setToolTip('MoucX')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          mainWindow?.show()
          mainWindow?.focus()
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

/**
 * End-to-end self check: preload bridge present, renderer booted, and every
 * service answering. This is what CI runs instead of a GUI test suite.
 */
async function runSmokeChecks(win: BrowserWindow): Promise<void> {
  if (!container) {
    smokeFail('容器未创建')
    return
  }
  try {
    const raw: unknown = await win.webContents.executeJavaScript(
      `(async () => {
        const api = window.mouc;
        if (!api) return { ok: false, missing: ['window.mouc 未注入'] };
        const missing = [];
        for (const ns of ['app','settings','version','instance','java','account','download','game','mod','server','loader','win']) {
          if (!api[ns]) { missing.push(ns); continue; }
          if (Object.keys(api[ns]).length === 0) missing.push(ns + ' 无方法');
        }
        if (typeof api.on !== 'function') missing.push('on');
        // Views are code-split, so the first paint can legitimately be empty; poll for
        // up to 5s instead of asserting on one frame.
        const deadline = Date.now() + 5000;
        let mounted = false;
        while (!mounted && Date.now() < deadline) {
          const root = document.getElementById('app');
          mounted = !!root && root.children.length > 0;
          if (!mounted) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return { ok: missing.length === 0 && mounted, missing, title: document.title };
      })()`
    )
    const bridge = raw as { ok?: boolean; missing?: string[]; title?: string }
    if (bridge.ok !== true) {
      smokeFail(`preload/渲染自检失败 ${JSON.stringify(bridge)}`)
      return
    }
    const roundTrip: unknown = await win.webContents.executeJavaScript(
      `(async () => {
        try {
          const result = await window.mouc.app.status();
          return { ok: !!result && result.ok === true, error: result && result.error ? result.error.message : '' };
        } catch (error) { return { ok: false, error: String(error) }; }
      })()`
    )
    const trip = roundTrip as { ok?: boolean; error?: string }
    if (trip.ok !== true) {
      // A non-cloneable reply shows up exactly here, which no type check can catch.
      smokeFail(`IPC app:status 往返失败 ${trip.error ?? ''}`)
      return
    }
    const status = await container.status()
    const settingsOk = typeof container.settings.get().gameRoot === 'string'
    if (!settingsOk) {
      smokeFail('设置读取失败')
      return
    }
    smokePass({
      title: bridge.title,
      instances: status.instances,
      java: status.java,
      accounts: status.accounts,
      gameRoot: status.gameRoot,
      online: status.online
    })
  } catch (error) {
    smokeFail(`自检异常 ${String(error)}`)
  }
}

function focusWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

async function onReady(): Promise<void> {
  app.setAppUserModelId('com.moucx.app')
  Menu.setApplicationMenu(null)
  container = createContainer()
  bootstrapLog.info(`启动 MoucX ${app.getVersion()} / Electron ${process.versions.electron}`)
  bootstrapLog.info(`游戏目录 ${container.paths().gameRoot}`)

  registerIpc(container, () => mainWindow)
  mainWindow = createWindow()

  // A crash in a service must be visible, not silently swallowed.
  process.on('uncaughtException', (error) => {
    bootstrapLog.error('未捕获异常', error)
    container?.log.error('未捕获异常', error)
  })
  process.on('unhandledRejection', (reason) => bootstrapLog.error('未处理的 Promise 拒绝', reason))

  if (container.settings.get().autoCheckUpdate) {
    void container
      .checkUpdate()
      .then((info) => {
        if (info.available) bootstrapLog.info(`发现新版本 ${info.latest}（当前 ${info.current}）`)
      })
      .catch((error: unknown) => bootstrapLog.warn(`自动更新检查失败: ${String(error)}`))
  }
}

app.on('second-instance', () => focusWindow())

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void app.whenReady().then(onReady).catch((error: unknown) => {
    bootstrapLog.error('启动失败', error)
    dialog.showErrorBox('MoucX 启动失败', String(error))
  })

  app.on('window-all-closed', () => {
    // Windows: the tray keeps us alive only when downloads or the game are running.
    if (runningGameCount() === 0 && activeDownloads() === 0) {
      quitting = true
      app.quit()
    }
  })

  app.on('before-quit', () => {
    quitting = true
    tray?.destroy()
    tray = null
    if (container) {
      void container.dispose().catch((error: unknown) => bootstrapLog.error('退出清理失败', error))
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) focusWindow()
  })
}
