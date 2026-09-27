/**
 * Защита от SSRF: приложение и backend читают только публичные адреса.
 *
 * Инструмент read_url умеет открывать ссылки, которые дал пользователь или
 * (что важнее) предложила модель. Без проверки такой запрос — готовый SSRF:
 * `http://127.0.0.1:8787/api/...`, `http://192.168.1.1/admin`, `http://router`,
 * а также публичный домен, чья A-запись ведёт внутрь сети. Поэтому перед каждым
 * запросом мы проверяем
 *   1) схему (только http/https),
 *   2) хост: служебные имена (localhost, *.local, имя без точки) — запрещены,
 *   3) IP-литерал: приватные, loopback и служебные диапазоны — запрещены,
 *   4) для доменов — куда ведут его A/AAAA-записи (защита от «DNS rebinding»),
 *   5) каждый редирект проверяется отдельно (см. guardedFetch).
 *
 * Модуль общий для браузера и Node: только global fetch + URL, без node:.
 * На backend резолвер DNS подменяется на нативный (см. server/reader.ts).
 */

/** Что показать пользователю, когда адрес заблокирован. */
export const NET_GUARD_HINT =
  'Читать можно только публичные адреса в интернете: localhost, локальная сеть и служебные диапазоны закрыты — иначе страница могла бы дёрнуть роутер или наш собственный backend.'

/** Адрес не прошёл проверку (SSRF). */
export class NetGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetGuardError'
  }
}

/** Как получить IP-адреса домена (подменяется в проверках и на backend). */
export type LookupFn = (host: string) => Promise<string[]>

export interface GuardOptions {
  /** Свой резолвер; `false` — вообще не проверять DNS (проверки IP и имён остаются) */
  lookup?: LookupFn | false
  /** Сколько ждать резолвер, мс (по умолчанию 6 с). Дольше — считаем DNS недоступным */
  lookupTimeoutMs?: number
  /** Куда писать замечания (например, «DNS недоступен — проверка пропущена») */
  warn?: (message: string) => void
}

const DNS_TIMEOUT_MS = 2500
/**
 * Жёсткий общий дедлайн на резолвер. Нужен потому, что «зависший» fetch
 * (нет сети до DoH-сервера, WebView без интернета) не всегда прерывается
 * AbortSignal'ом: в Node фаза DNS в undici не отменяется. Без дедлайна
 * проверка адреса держала бы чтение страницы бесконечно.
 */
const DNS_DEADLINE_MS = 6000
const DNS_TTL_MS = 60_000
/** Кэш адресов по домену: read_url за один ход может обратиться к сайту дважды. */
const DNS_CACHE = new Map<string, { addresses: string[]; at: number }>()

function octets(value: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value.trim())
  if (!match) return null
  const parts = match.slice(1).map(Number)
  return parts.some((n) => n > 255) ? null : parts
}

/** Вернуть два 16-битных слова из четырёх октетов. */
function ipv4Words(parts: number[]): number[] {
  return [(parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]]
}

/** Два 16-битных слова → строка IPv4 (для проверки вложенного адреса). */
function wordsToIpv4(words: number[]): string {
  return words.map((w) => `${w >> 8}.${w & 0xff}`).join('.')
}

/**
 * Разбор IPv6 в восемь 16-битных групп. Поддерживает `::`, зону (`%eth0`)
 * и «IPv4-хвост» (`::ffff:192.168.1.1`). null — строка не IPv6.
 */
export function parseIpv6(raw: string): number[] | null {
  let value = raw.trim().replace(/^\[|\]$/g, '').toLowerCase()
  const zone = value.indexOf('%')
  if (zone !== -1) value = value.slice(0, zone)
  if (!value.includes(':')) return null

  // IPv4-хвост заменяем на две шестнадцатеричные группы
  const lastColon = value.lastIndexOf(':')
  const tailText = value.slice(lastColon + 1)
  if (tailText.includes('.')) {
    const v4 = octets(tailText)
    if (!v4) return null
    const words = ipv4Words(v4).map((w) => w.toString(16))
    value = `${value.slice(0, lastColon + 1)}${words[0]}:${words[1]}`
  }

  const sides = value.split('::')
  if (sides.length > 2) return null
  const head = sides[0] ? sides[0].split(':') : []
  const tail = sides.length === 2 && sides[1] ? sides[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (sides.length === 1 ? head.length !== 8 : missing < 1) return null
  const groups = [...head, ...Array(sides.length === 2 ? missing : 0).fill('0'), ...tail]
  if (groups.length !== 8) return null
  const numbers = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : -1))
  return numbers.some((n) => n < 0) ? null : numbers
}

/** Является ли строка IP-адресом (v4 или v6). */
export function isIpAddress(host: string): boolean {
  if (octets(host)) return true
  return host.includes(':') && parseIpv6(host) !== null
}

/**
 * Приватный или служебный IPv4-адрес? Неразобранное значение считается
 * небезопасным (fail-closed) — так безопаснее ошибиться в сторону запрета.
 */
export function isPrivateIpv4(ip: string): boolean {
  const parts = octets(ip)
  if (!parts) return true
  const [a, b, c] = parts
  if (a === 0 || a === 10 || a === 127) return true // «этот хост», приватная сеть, loopback
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 169 && b === 254) return true // link-local (метаданные облаков)
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && c === 0) return true // 192.0.0.0/24 — служебные протоколы
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18/15 — бенчмарки
  if (a >= 224) return true // multicast 224/4 и зарезервированное 240/4
  return false
}

/** Приватный или служебный IPv6-адрес (неразобранное значение → true). */
export function isPrivateIpv6(ip: string): boolean {
  const groups = parseIpv6(ip)
  if (!groups) return true
  if (groups.every((g) => g === 0)) return true // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true // ::1
  const headEmpty = groups.slice(0, 5).every((g) => g === 0)
  // IPv4-mapped (::ffff:a.b.c.d) и IPv4-compatible (::a.b.c.d)
  if (headEmpty && (groups[5] === 0xffff || groups[5] === 0)) {
    return isPrivateIpv4(wordsToIpv4(groups.slice(6)))
  }
  const first = groups[0]
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 — unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 — link-local
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 — multicast
  if (first === 0x2001 && groups[1] === 0x0db8) return true // 2001:db8::/32 — документация
  // NAT64 64:ff9b::/96 — за ним может стоять приватный IPv4
  if (first === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return isPrivateIpv4(wordsToIpv4(groups.slice(6)))
  }
  return false
}

/** Приватный адрес в любой записи (используется для ответов DNS). */
export function isPrivateAddress(ip: string): boolean {
  return ip.includes(':') ? isPrivateIpv6(ip) : isPrivateIpv4(ip)
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.onion']

/** Причина запрета служебного имени, либо undefined. */
export function blockedHostnameReason(host: string): string | undefined {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!value) return 'пустое имя хоста'
  if (value === 'localhost' || value === 'localhost.localdomain') return 'localhost'
  const suffix = BLOCKED_SUFFIXES.find((s) => value.endsWith(s))
  if (suffix) return `служебная зона ${suffix}`
  if (isIpAddress(value)) return undefined
  if (!value.includes('.')) return 'имя без домена — адрес устройства в локальной сети'
  return undefined
}

/** Хост URL без квадратных скобок IPv6. */
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '')
}

async function dnsQuery(url: string): Promise<string[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DNS_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`DNS HTTP ${res.status}`)
    const json = (await res.json()) as { Answer?: Array<{ type?: number; data?: string }> }
    return (json.Answer ?? [])
      .filter((a) => a.type === 1 || a.type === 28)
      .map((a) => String(a.data ?? '').trim())
      .filter(Boolean)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Адреса домена через DNS-over-HTTPS (по умолчанию Cloudflare, запасной — Google).
 * Нужно именно «куда ведёт домен»: обычный fetch не даёт узнать IP до запроса.
 */
export async function dnsOverHttps(host: string): Promise<string[]> {
  const name = encodeURIComponent(host)
  let lastError: unknown
  for (const base of ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']) {
    try {
      const [v4, v6] = await Promise.all([
        dnsQuery(`${base}?name=${name}&type=A`),
        dnsQuery(`${base}?name=${name}&type=AAAA`),
      ])
      // Резолвер ответил: адресов нет (NXDOMAIN) — второй резолвер не поможет.
      return [...v4, ...v6]
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('DNS недоступен')
}

/** Резолвер по умолчанию с кэшем на минуту (переживает два запроса за один ход). */
export async function resolveHostIps(host: string): Promise<string[]> {
  const cached = DNS_CACHE.get(host)
  if (cached && Date.now() - cached.at < DNS_TTL_MS) return cached.addresses
  const addresses = await dnsOverHttps(host)
  DNS_CACHE.set(host, { addresses, at: Date.now() })
  return addresses
}

/** Сброс кэша DNS — для проверок. */
export function resetDnsCache(): void {
  DNS_CACHE.clear()
}

/**
 * Не дать промису висеть дольше срока: даже если он никогда не завершится
 * (зависший fetch), мы вернём управление и продолжим с замечанием.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/**
 * Проверяет адрес и возвращает разобранный URL. Бросает NetGuardError, если
 * адрес ведёт внутрь устройства или локальной сети.
 *
 * Если DNS недоступен или молчит (нет сети у самого резолвера), запрос не
 * блокируем, но сообщаем через warn: иначе приложение ломало бы чтение страниц
 * в «глухом» интернете, где сам сайт при этом открывается. Ждём резолвер
 * ограниченное время (lookupTimeoutMs, по умолчанию 6 с) — «зависший» fetch
 * не должен держать чтение страницы. Проверки IP и служебных имён при этом
 * всё равно работают.
 */
export async function assertPublicUrl(
  input: string | URL,
  options: GuardOptions = {},
): Promise<URL> {
  const url = typeof input === 'string' ? new URL(input) : input
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetGuardError(`Поддерживаются только http/https-ссылки, получено ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new NetGuardError('Ссылка с логином и паролем в адресе не поддерживается.')
  }

  const host = hostOf(url)
  if (!host) throw new NetGuardError('В ссылке нет домена.')

  if (isIpAddress(host)) {
    if (isPrivateAddress(host)) {
      throw new NetGuardError(
        `Адрес ${host} ведёт внутрь устройства или локальной сети — запрос заблокирован. ${NET_GUARD_HINT}`,
      )
    }
    return url
  }

  const nameReason = blockedHostnameReason(host)
  if (nameReason) {
    throw new NetGuardError(
      `Заблокирован служебный адрес ${host} (${nameReason}). ${NET_GUARD_HINT}`,
    )
  }

  if (options.lookup === false) return url
  const lookup = options.lookup ?? resolveHostIps
  const deadline = options.lookupTimeoutMs ?? DNS_DEADLINE_MS
  let addresses: string[]
  try {
    addresses = await withDeadline(
      lookup(host),
      deadline,
      `DNS не ответил за ${Math.round(deadline / 1000)} с`,
    )
  } catch (err) {
    options.warn?.(
      `Не удалось проверить DNS для ${host}: ${err instanceof Error ? err.message : String(err)}. Проверка адреса пропущена.`,
    )
    return url
  }
  const internal = addresses.find((ip) => isPrivateAddress(ip))
  if (internal) {
    throw new NetGuardError(
      `Домен ${host} ведёт на внутренний адрес ${internal} — запрос заблокирован. ${NET_GUARD_HINT}`,
    )
  }
  return url
}

export interface GuardedResponse {
  response: Response
  /** Куда в итоге пришли после редиректов */
  finalUrl: string
  /** Все адреса по пути (для диагностики и замечаний) */
  visited: string[]
}

export interface GuardedFetchOptions {
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Максимум перенаправлений (по умолчанию 5) */
  maxRedirects?: number
  /** Свой резолвер DNS; false — не проверять DNS */
  lookup?: LookupFn | false
  /** Сколько ждать резолвер, мс */
  lookupTimeoutMs?: number
  warn?: (message: string) => void
  /** Подмена fetch — используется в проверках */
  fetchImpl?: typeof fetch
}

export const MAX_REDIRECTS = 5

/** Редирект, содержимое которого браузер не отдаёт при redirect: 'manual'. */
function isOpaqueRedirect(res: Response): boolean {
  return res.type === 'opaqueredirect' || (res.status === 0 && !res.headers.get('location'))
}

/**
 * fetch с защитой от SSRF: адрес проверяется ДО запроса, каждый редирект —
 * отдельно, «опознанный» браузером переход проверяется по итоговому адресу.
 *
 * Заголовки авторизации/куки на чужие хосты не переносятся: куки браузер
 * шлёт сам по своим правилам, а мы добавляем только переданные headers —
 * это фиксированный набор «как обычный браузер» (см. BROWSER_HEADERS).
 */
export async function guardedFetch(
  url: string | URL,
  options: GuardedFetchOptions = {},
): Promise<GuardedResponse> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new NetGuardError('В этом окружении нет fetch — сеть недоступна.')
  }
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS
  const guard: GuardOptions = {
    lookup: options.lookup,
    lookupTimeoutMs: options.lookupTimeoutMs,
    warn: options.warn,
  }
  const visited: string[] = []
  const init: RequestInit = {
    method: 'GET',
    headers: options.headers,
    signal: options.signal,
  }
  let current = String(url)

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const target = await assertPublicUrl(current, guard)
    const res = await fetchImpl(target.href, { ...init, redirect: 'manual' })
    visited.push(target.href)

    // Браузер не показывает заголовки редиректа при redirect: 'manual' — идём по
    // нему сами и проверяем итоговый адрес, прежде чем отдать содержимое наружу.
    if (isOpaqueRedirect(res)) {
      const followed = await fetchImpl(target.href, { ...init, redirect: 'follow' })
      const finalUrl = followed.url || target.href
      if (finalUrl !== target.href) {
        visited.push(finalUrl)
        await assertPublicUrl(finalUrl, guard)
      }
      return { response: followed, finalUrl, visited }
    }

    const location =
      res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!location) {
      // Часть сред (нативный HTTP в APK) идёт по редиректам сама, даже когда мы
      // просим redirect: 'manual'. Тогда итоговый адрес проверяем по факту
      // ответа — до того, как содержимое уйдёт дальше.
      const landed = res.url && res.url !== target.href ? res.url : ''
      if (landed) {
        visited.push(landed)
        try {
          await assertPublicUrl(landed, guard)
        } catch (err) {
          await res.body?.cancel().catch(() => undefined)
          throw err
        }
      }
      return { response: res, finalUrl: landed || target.href, visited }
    }

    // Тело редиректа нам не нужно — освобождаем соединение.
    await res.body?.cancel().catch(() => undefined)
    current = new URL(location, target.href).href
  }

  throw new NetGuardError(
    `Слишком много перенаправлений (${maxRedirects}) — цепочка прервана. Последний адрес: ${visited[visited.length - 1] ?? url}`,
  )
}


