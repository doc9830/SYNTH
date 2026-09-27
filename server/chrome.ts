import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Мини-клиент Chrome DevTools Protocol (CDP) без внешних зависимостей.
 *
 * Зачем: чтобы «читать» страницы так, как их видит настоящий браузер —
 * рендерить JS-лендинги (SPA, React), получать отрендеренный текст,
 * ссылки, картинки и делать скриншоты.
 *
 * Установщик зависимостей не нужен: в Node 22 есть глобальный WebSocket,
 * а сам браузер берём системный (Chrome/Chromium/Edge).
 */

const CHROME_CANDIDATES: string[] = [
  process.env.CHROME_PATH ?? '',
  process.env.PUPPETEER_EXECUTABLE_PATH ?? '',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter((p) => p.length > 0)

let cachedChrome: string | null | undefined

/** Путь к браузеру. null — Chrome/Chromium не найден (остаётся статический режим). */
export function findChrome(): string | null {
  if (cachedChrome !== undefined) return cachedChrome
  cachedChrome =
    CHROME_CANDIDATES.find((path) => {
      try {
        return existsSync(path)
      } catch {
        return false
      }
    }) ?? null
  return cachedChrome
}

/** Крупная версия браузера — от неё зависит старый/новый флаг headless. */
let cachedMajor: number | undefined

function chromeMajor(bin: string): number {
  if (cachedMajor !== undefined) return cachedMajor
  cachedMajor = 0
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 })
    const m = out.match(/(\d+)\./)
    if (m) cachedMajor = Number(m[1])
  } catch {
    /* не смогли узнать версию — считаем современным */
  }
  return cachedMajor
}

interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: Record<string, unknown>
  error?: { message?: string; code?: number }
}

interface CdpConnection {
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, unknown>>
  on: (event: string, handler: (params: Record<string, unknown>) => void) => () => void
  close: () => void
}

function connect(wsUrl: string, timeoutMs: number): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>()
    const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()
    let seq = 0

    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      reject(new Error(`Chrome не ответил на CDP за ${timeoutMs} мс`))
    }, timeoutMs)

    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve({
        send: (method, params = {}, sessionId) =>
          new Promise((res, rej) => {
            seq += 1
            const id = seq
            pending.set(id, { resolve: res, reject: rej })
            ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
          }),
        on: (event, handler) => {
          const set = listeners.get(event) ?? new Set()
          set.add(handler)
          listeners.set(event, set)
          return () => set.delete(handler)
        },
        close: () => {
          try {
            ws.close()
          } catch {
            /* ignore */
          }
        },
      })
    })

    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('Не удалось подключиться к Chrome по CDP'))
    })

    ws.addEventListener('message', (event) => {
      let msg: CdpMessage
      try {
        msg = JSON.parse(String(event.data)) as CdpMessage
      } catch {
        return
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id)!
        pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message ?? 'Ошибка CDP'))
        else res(msg.result ?? {})
        return
      }
      if (msg.method) {
        for (const handler of listeners.get(msg.method) ?? []) handler(msg.params ?? {})
      }
    })
  })
}

export interface ScreenshotOptions {
  /** jpeg (по умолчанию, легче) или png */
  format?: 'jpeg' | 'png'
  /** Качество jpeg, 1..100 */
  quality?: number
  /** Снять всю страницу целиком, а не только первый экран */
  fullPage?: boolean
}

export interface Screenshot {
  /** base64 без префикса data: */
  base64: string
  format: 'jpeg' | 'png'
  width: number
  height: number
}

export interface ChromePage {
  navigate: (url: string, opts?: { waitMs?: number; timeoutMs?: number }) => Promise<void>
  /** Выполнить JS в контексте страницы и вернуть значение (должно быть JSON-сериализуемым) */
  evaluate: <T>(expression: string) => Promise<T>
  /** Реальный размер документа (для fullPage) */
  contentSize: () => Promise<{ width: number; height: number }>
  screenshot: (opts?: ScreenshotOptions) => Promise<Screenshot>
}

export interface ChromePageOptions {
  width?: number
  height?: number
  /** Сколько ждать запуск браузера/загрузку */
  timeoutMs?: number
  /** Сколько «досидеть» после load — для анимаций и ленивых картинок */
  waitMs?: number
  signal?: AbortSignal
}

const MAX_CAPTURE_HEIGHT = 12000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForPort(profileDir: string, timeoutMs: number, proc: ChildProcess): Promise<string> {
  const file = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (existsSync(file)) {
        try {
          const [portLine, pathLine] = readFileSync(file, 'utf8').split('\n')
          const port = Number(portLine)
          if (port > 0) {
            resolve(`ws://127.0.0.1:${port}${(pathLine ?? '').trim() || '/devtools/browser'}`)
            return
          }
        } catch {
          /* файл ещё дописывается — пробуем снова */
        }
      }
      if (proc.exitCode !== null) {
        reject(new Error(`Chrome завершился сразу после старта (код ${proc.exitCode})`))
        return
      }
      if (Date.now() > deadline) {
        reject(new Error(`Chrome не успел поднять CDP за ${timeoutMs} мс`))
        return
      }
      setTimeout(tick, 100)
    }
    tick()
  })
}

/**
 * Поднять headless Chrome, выполнить fn с объектом страницы и прибрать за собой
 * (закрыть таргет, убить процесс, удалить временный профиль).
 */
export async function withChromePage<T>(
  options: ChromePageOptions,
  fn: (page: ChromePage) => Promise<T>,
): Promise<T> {
  const bin = findChrome()
  if (!bin) {
    throw new Error(
      'Chrome/Chromium не найден. Укажите путь в CHROME_PATH (.env), чтобы включить рендер страниц и скриншоты.',
    )
  }
  const width = options.width ?? 1440
  const height = options.height ?? 900
  const startTimeout = options.timeoutMs ?? 25000
  const profileDir = mkdtempSync(join(tmpdir(), 'ds-chat-chrome-'))
  const major = chromeMajor(bin)

  const args = [
    major >= 112 ? '--headless=new' : '--headless',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--force-color-profile=srgb',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    'about:blank',
  ]
  // в контейнерах/под root sandbox недоступен
  if (process.getuid?.() === 0) args.unshift('--no-sandbox')

  let proc: ChildProcess | null = spawn(bin, args, { stdio: 'ignore' })
  let browser: CdpConnection | null = null
  let targetId = ''
  let aborted = false

  const cleanup = async () => {
    try {
      if (browser && targetId) await browser.send('Target.closeTarget', { targetId })
    } catch {
      /* ignore */
    }
    browser?.close()
    if (proc && proc.exitCode === null) {
      proc.kill('SIGKILL')
      await sleep(50)
    }
    proc = null
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  const onAbort = () => {
    aborted = true
    if (proc && proc.exitCode === null) proc.kill('SIGKILL')
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const wsUrl = await waitForPort(profileDir, startTimeout, proc)
    if (aborted) throw new Error('Чтение страницы остановлено.')
    browser = await connect(wsUrl, startTimeout)
    const created = await browser.send('Target.createTarget', { url: 'about:blank' })
    targetId = String(created.targetId ?? '')
    const attached = await browser.send('Target.attachToTarget', { targetId, flatten: true })
    const sessionId = String(attached.sessionId ?? '')

    const send = (method: string, params: Record<string, unknown> = {}) =>
      browser!.send(method, params, sessionId)
    const on = (event: string, handler: (params: Record<string, unknown>) => void) =>
      browser!.on(event, handler)

    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })

    const page: ChromePage = {
      async navigate(url, opts = {}) {
        const loadTimeout = opts.timeoutMs ?? 15000
        const race = (events: string[], timeoutMs: number) =>
          new Promise<void>((resolve) => {
            const offs = events.map((event) =>
              on(event, () => {
                for (const off of offs) off()
                clearTimeout(timer)
                resolve()
              }),
            )
            const timer = setTimeout(() => {
              for (const off of offs) off()
              resolve()
            }, timeoutMs)
          })

        // Ждём готовности DOM (быстро) либо полного load — что случится раньше.
        // Тяжёлые лендинги (аналитика, видео, вечные запросы) часто вообще не
        // доходят до loadEventFired, поэтому на нём не залипаем.
        const domReady = race(['Page.domContentEventFired', 'Page.loadEventFired'], Math.min(loadTimeout, 8000))
        const res = await send('Page.navigate', { url })
        if (res.errorText) throw new Error(`Chrome не открыл страницу: ${String(res.errorText)}`)
        await domReady
        // даём догрузиться остаточным ресурсам, но не дольше 5 секунд
        await race(['Page.loadEventFired'], Math.min(loadTimeout, 5000))
        // даём дорисоваться анимациям, шрифтам и ленивым картинкам
        await sleep(opts.waitMs ?? options.waitMs ?? 700)
        if (aborted) throw new Error('Чтение страницы остановлено.')
      },

      async evaluate<T>(expression: string) {
        const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        const details = res.exceptionDetails as { exception?: { description?: string } } | undefined
        if (details) throw new Error(details.exception?.description ?? 'Ошибка JS на странице')
        return (res.result as { value?: T } | undefined)?.value as T
      },

      async contentSize() {
        const metrics = await send('Page.getLayoutMetrics')
        const size = (metrics.cssContentSize ?? metrics.contentSize ?? {}) as { width?: number; height?: number }
        return { width: Math.ceil(size.width ?? width), height: Math.ceil(size.height ?? height) }
      },

      async screenshot(opts = {}) {
        const format = opts.format ?? 'jpeg'
        const quality = Math.min(Math.max(opts.quality ?? 78, 1), 100)
        let captureHeight = height
        if (opts.fullPage) {
          const size = await page.contentSize()
          captureHeight = Math.min(Math.max(size.height, height), MAX_CAPTURE_HEIGHT)
          await send('Emulation.setDeviceMetricsOverride', {
            width,
            height: captureHeight,
            deviceScaleFactor: 1,
            mobile: false,
          })
          await sleep(250)
        }
        const res = await send('Page.captureScreenshot', {
          format,
          quality,
          captureBeyondViewport: Boolean(opts.fullPage),
          fromSurface: true,
        })
        return { base64: String(res.data ?? ''), format, width, height: captureHeight }
      },
    }

    return await fn(page)
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    await cleanup()
  }
}

