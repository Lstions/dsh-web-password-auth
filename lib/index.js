/**
 * dsh-web-password-auth —— 用「用户名 + 密码」替换 DSH Web 的启动令牌登录。
 *
 * ## 它做什么
 *
 * 在启动令牌之外，再提供一条**密码登录**入口，并让登录状态在浏览器里持久化
 * 到用户主动退出为止。启动令牌**保留**，作为本机兜底入口（忘记密码时的自救通道）。
 *
 * ## 挂在哪里、为什么不改核心
 *
 * 认证的最终判据是「cookie = HMAC(secret, 绑定 authority 的 payload)」，而 secret
 * 是 `ctx.credentials` 里一条持久 grant 记录。本插件在 Connection 之后激活，读到
 * **同一把密钥**，因此可以自己签发 cookie；签出的 cookie 会被宿主原样接受
 * （`GET /`、`/api/*`、`/api/remote.mux` 的 WS 升级三条路径实测全通）。
 *
 * 三个介入点都是公开扩展点：
 * 1. `webServer.register({kind:'exact'})` —— 精确路由优先于 fallback，
 *    所以能抢在 `frontend-static` 的 401 之前接管 `/` 与 `/index.html`。
 * 2. `connection.requestRejection()` —— 借它做 Host/Origin 校验，
 *    并配合自己的 cookie 校验判断"是否已登录"。
 * 3. `webServer.renderIndex()` —— 已登录时自己渲染 index（不动静态资源，
 *    那些本来就由 `frontend-static` 公开提供）。
 *
 * 用户/密码/TOTP 状态存在 `ctx.credentials` 的两个自有记录里，绝不复用
 * `client-connection/browser-session`（那条的形状被宿主严格校验）。
 *
 * @module dsh-web-password-auth
 */

import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { delimiter as pathDelimiter, dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

import {
  DAY_MILLISECONDS, clearCookie, cookieName, encodeBase64Url, generateTotpSecret,
  hashPassword, mintCookieValue, parseSigningSecret, readCookieValue, requestAuthority,
  sessionCookie, totpUri, verifyCookieValue, verifyPassword, verifyTotp,
} from './crypto.js'
import { qrDataUri } from './qr.js'
import {
  renderErrorPage, renderLoginPage, renderSetupPage, stringsFor,
} from './pages.js'

/** Loader 行 id，也是设置页的配置命名空间。 */
export const name = 'web-password-auth'

/** 需要 webServer 注册路由、connection 判认证、credentials 存取密钥与口令。 */
export const inject = ['webServer', 'connection', 'credentials']

/** 插件配置。 */
export const Config = z.object({
  /** 会话 cookie 的有效期（天）。不得超过宿主 `connection.cookieMaxAgeDays`。 */
  sessionDays: z.natural().min(1).default(365),
  /** 未设密码时是否只允许 loopback 创建账户。 @default true */
  bootstrapLoopbackOnly: z.boolean().default(true),
  /** 连续登录失败多少次后锁定。 @default 5 */
  maxAttempts: z.natural().min(1).default(5),
  /** 锁定时长（毫秒）。 @default 300000 */
  lockoutMs: z.natural().min(1).default(300_000),
  /** 密码最小长度。 @default 8 */
  minPasswordLength: z.natural().min(1).default(8),
  /** TOTP 发行者名称，显示在验证器 App 里。 @default 'DSH' */
  totpIssuer: z.string().default('DSH'),
  /** 是否提供两步验证能力。关闭后账户页不出现开户入口。 @default true */
  totpAvailable: z.boolean().default(true),
})

/** 签名密钥记录的 key，与 browser-auth.ts:14 一致。 */
const SIGNING_KEY = 'client-connection/browser-session'
/** 口令记录的 key。 */
const PASSWORD_KEY = 'web-auth/password'
/** TOTP 记录的 key。 */
const TOTP_KEY = 'web-auth/totp'

const HTML_TYPE = 'text/html; charset=utf-8'
const TEXT_TYPE = 'text/plain; charset=utf-8'
/** 请求体上限：登录表单远小于此；超限直接掐断，避免内存放大。 */
const MAX_BODY_BYTES = 8192
/** 失败一次至少延迟这么久，压缩时序侧信道并拖慢爆破。 */
const MIN_FAILURE_DELAY_MS = 300

/** 内存里的登录失败计数；进程重启即清零，单用户场景足够。 */
class FailureLimiter {
  #entries = new Map()

  /**
   * @param {number} maxAttempts - 允许的连续失败次数。
   * @param {number} lockoutMs - 锁定毫秒数。
   */
  constructor(maxAttempts, lockoutMs) {
    this.maxAttempts = maxAttempts
    this.lockoutMs = lockoutMs
  }

  /**
   * 当前是否被锁定。
   * `until` 为 0 表示未锁定；只有明确写入过未来时刻才算锁定。
   * @param {string} key - 限速维度。
   * @returns {{locked: boolean, remainingMs: number}} 状态。
   */
  check(key) {
    const entry = this.#entries.get(key)
    if (entry === undefined) return { locked: false, remainingMs: 0 }
    const remainingMs = entry.until - Date.now()
    if (entry.until === 0 || remainingMs <= 0) return { locked: false, remainingMs: 0 }
    return { locked: true, remainingMs }
  }

  /**
   * 记录一次失败，达到阈值即锁定。
   * 锁定期内的再次失败不重置计时，避免攻击者靠持续请求延长自己的锁定期。
   * @param {string} key - 限速维度。
   */
  fail(key) {
    const now = Date.now()
    const entry = this.#entries.get(key)
    if (entry !== undefined && entry.until > now) return
    // 锁定已过期时重新计数。
    const count = (entry === undefined || entry.until !== 0 ? 0 : entry.count) + 1
    this.#entries.set(key, { count, until: count >= this.maxAttempts ? now + this.lockoutMs : 0 })
  }

  /**
   * 成功后清空该维度的失败记录。
   * @param {string} key - 限速维度。
   */
  reset(key) {
    this.#entries.delete(key)
  }
}

/**
 * 读取请求体并按表单解析。超限立即 reject，不把大包读进内存。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<Record<string, string>>} 表单字段。
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

/**
 * 读取 `application/x-www-form-urlencoded` 请求体。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<Record<string, string>>} 表单字段。
 */
async function readForm(req) {
  const text = await readRawBody(req)
  return Object.fromEntries(new URLSearchParams(text))
}

/**
 * 读取 JSON 请求体，同时兼容表单。
 *
 * 页内设置面板发 `application/json`，HTML 表单发 urlencoded；两种都必须解析对，
 * 否则请求体会变成空对象，表现为"密码永远太短"这类误导性错误。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<Record<string, unknown>>} 请求字段。
 */
async function readJsonBody(req) {
  const text = await readRawBody(req)
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch {
      // 不是合法 JSON：按表单再试一次。
    }
  }
  return Object.fromEntries(new URLSearchParams(text))
}

/**
 * 用户名允许的字符集：字母、数字，以及 `._@+-`。
 *
 * 放宽到 Unicode 字母/数字，因为这是一个单用户标签而不是系统账号名；排除空白和
 * 控制字符，避免它在登录页、验证器条目和日志里造成歧义。
 */
const USERNAME_PATTERN = /^[\p{L}\p{N}._@+-]{1,64}$/u

/**
 * 规范化并校验用户名。
 * @param {unknown} value - 用户输入。
 * @returns {string|undefined} 合法用户名；非法时 undefined。
 */
function normalizeUsername(value) {
  const trimmed = String(value ?? '').trim()
  return USERNAME_PATTERN.test(trimmed) ? trimmed : undefined
}

/**
 * 登录限速的来源维度。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {string} 规范化后的来源地址。
 */
function sourceKey(req) {
  const address = req.socket?.remoteAddress ?? 'unknown'
  // ::ffff:127.0.0.1 与 127.0.0.1 视为同一来源。
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

/**
 * 来源是否为 loopback。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {boolean} 是否本机。
 */
function isLoopback(req) {
  const key = sourceKey(req)
  return key === '127.0.0.1' || key === '::1'
}

/**
 * 最小化重定向响应。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {string} location - 目标。
 * @param {number} [status] - 状态码，默认 303。
 */
function redirect(res, location, status = 303) {
  res.writeHead(status, { 'cache-control': 'no-store', location, 'referrer-policy': 'no-referrer' })
  res.end()
}

/**
 * 返回 HTML。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {string} body - HTML 文本。
 */
function sendHtml(res, status, body) {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': HTML_TYPE, 'referrer-policy': 'no-referrer' })
  res.end(body)
}

/**
 * 返回纯文本。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {string} body - 文本。
 */
function sendText(res, status, body) {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': TEXT_TYPE })
  res.end(body)
}

/**
 * 从 Accept-Language 取语言偏好。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {string} 语言头原文。
 */
function localeOf(req) {
  const header = req.headers['accept-language']
  return typeof header === 'string' ? header : ''
}

/**
 * 固定延迟，让失败路径不会被响应时间识别出来。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 延迟完成。
 */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * 构造并注册整个插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} config - 已通过 schema 的配置。
 */
export function apply(ctx, config) {
  // 激活即可见的一条日志：排查"插件没生效"时先确认 apply 有没有跑到。
  ctx.logger.info('web-password-auth: activating')
  const settings = config ?? {}
  const sessionDays = settings.sessionDays ?? 365
  const bootstrapLoopbackOnly = settings.bootstrapLoopbackOnly ?? true
  const minPasswordLength = settings.minPasswordLength ?? 8
  const totpIssuer = settings.totpIssuer ?? 'DSH'
  const totpAvailable = settings.totpAvailable ?? true
  /**
   * 找到宿主 Connection 在 Loader 里的那一行。
   *
   * 不能按 `id === 'connection'` 找：bundle 的行挂在 `include` 组里，实际 id 是
   * `include:connection`（组前缀）。所以按**模块名**匹配，再退回 id 后缀。
   * @returns {object|undefined} Loader 行。
   */
  const connectionRow = () => {
    const loader = ctx.get('loader')
    if (loader === undefined) return undefined
    const rows = [...loader.entries()]
    const byName = rows.find(row => row.options?.name === '@deepseek-ai/dsh-client-connection')
    if (byName !== undefined) return byName
    return rows.find(row => row.id === 'connection' || String(row.id).endsWith(':connection'))
  }

  /**
   * 宿主 `connection.cookieMaxAgeDays` 是硬上限：插件签发的 cookie 只要有效期
   * 超过它，宿主一律判 401（browser-auth.ts 的 `expiresAt - issuedAt > maxAge`）。
   * 也就是说配置不匹配时，登录"看起来成功、实际永远进不去"，极难排查。
   *
   * 所以这里主动从 Loader 里读出宿主的实际值，取两者较小者。读不到时才信任
   * 自己的配置（并会在日志里提示）。
   * @returns {number|undefined} 宿主的会话天数上限。
   */
  const hostSessionDays = () => {
    const loader = ctx.get('loader')
    if (loader === undefined) return undefined
    const row = connectionRow()
    if (row === undefined) return undefined
    // fiber.config 是**已解析**的配置（`!!js` 表达式求值之后），row.options.config
    // 还是原文。优先读前者，两者都试是因为不同启动路径下只有一个存在。
    for (const candidate of [row.fiber?.config, row.options?.config]) {
      const value = candidate?.cookieMaxAgeDays
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
    }
    return undefined
  }

  const hostDays = hostSessionDays()
  const effectiveDays = hostDays !== undefined && hostDays < sessionDays ? hostDays : sessionDays
  if (hostDays !== undefined && hostDays < sessionDays) {
    ctx.logger.warn(
      'web-password-auth: connection.cookieMaxAgeDays is %s but sessionDays is %s; '
      + 'using %s so the Host accepts the cookies. Raise cookieMaxAgeDays to get longer sessions.',
      String(hostDays), String(sessionDays), String(effectiveDays),
    )
  }
  const sessionMaxAge = effectiveDays * DAY_MILLISECONDS
  const limiter = new FailureLimiter(settings.maxAttempts ?? 5, settings.lockoutMs ?? 300_000)

  /** 激活时读一次并缓存；宿主换密钥后由吊销流程重新读取。 */
  let signingSecret
  /** 已吊销的 cookie 值 → 它的自然过期时刻，用于让"退出"立即在服务端生效。 */
  const revokedUntil = new Map()

  /** 宿主是否服务 TLS —— 决定 cookie 的 Secure 与 authority 形态。 */
  const secure = () => ctx.get('webServer')?.protocol === 'https:'

  /**
   * 读取签名密钥。Connection 先于本插件激活并保证记录存在，
   * 因此读失败即真异常，必须报出来而不是静默降级。
   * @returns {Promise<Buffer|undefined>} 32 字节密钥。
   */
  const readSecret = async () => parseSigningSecret(await ctx.credentials.readRecord(SIGNING_KEY))

  /**
   * 取当前可用的签名密钥，必要时读取并缓存。
   *
   * 不能只在激活时读一次：激活时的异步读取可能与首个请求竞争，让本该成功的
   * 登录静默失败。这里改成"用到时确保已就绪"，激活路径只是提前预热。
   * @returns {Promise<Buffer|undefined>} 密钥。
   */
  const ensureSecret = async () => {
    if (signingSecret !== undefined) return signingSecret
    signingSecret = await readSecret()
    return signingSecret
  }

  /** @returns {Promise<object|undefined>} 口令记录。 */
  const readPasswordRecord = () => ctx.credentials.readRecord(PASSWORD_KEY)

  /** @returns {Promise<object|undefined>} TOTP 记录。 */
  const readTotpRecord = () => ctx.credentials.readRecord(TOTP_KEY)

  /**
   * 判断请求是否已登录：先过宿主的 Host/Origin 围栏，再验本插件的 cookie。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @returns {Promise<boolean>} 是否已认证。
   */
  const isAuthenticated = async (req) => {
    if (ctx.connection.requestRejection(req) !== undefined) return false
    const secret = await ensureSecret()
    if (secret === undefined) return false
    const authority = requestAuthority(req.headers, secure())
    if (authority === undefined) return false
    const value = readCookieValue(req.headers.cookie, cookieName(authority))
    if (value === undefined) return false
    if (revokedUntil.has(value)) return false
    return verifyCookieValue(value, secret, authority, sessionMaxAge) !== undefined
  }

  /**
   * 签发会话 cookie 写进响应。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @param {string} authority - 请求 audience。
   * @returns {Promise<boolean>} 是否签发成功。
   */
  const issueCookie = async (res, authority) => {
    const secret = await ensureSecret()
    if (secret === undefined) return false
    const now = Date.now()
    const expiresAt = now + sessionMaxAge
    const value = mintCookieValue(secret, authority, now, expiresAt)
    res.setHeader('set-cookie', sessionCookie(cookieName(authority), value, {
      expiresAt, maxAgeSeconds: Math.floor(sessionMaxAge / 1000), secure: secure(),
    }))
    return true
  }

  /**
   * 清掉会话 cookie。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @param {string} authority - 请求 audience。
   */
  const revokeCookie = (res, authority) => {
    res.setHeader('set-cookie', clearCookie(cookieName(authority), secure()))
  }

  /**
   * 让某个已签发的 cookie 立刻失效。
   *
   * 只清浏览器里的 cookie 是不够的：服务端仍然会接受那个值，所以被窃取的
   * cookie 在"退出"后依然可用。这里把它的签名记进失效表，本进程内立即拒绝。
   * 表项在 cookie 自身过期时自然淘汰，不会无限增长。
   * @param {import('node:http').IncomingMessage} req - 携带待吊销 cookie 的请求。
   */
  const revokeSession = (req) => {
    const authority = requestAuthority(req.headers, secure())
    if (authority === undefined) return
    const value = readCookieValue(req.headers.cookie, cookieName(authority))
    if (value === undefined) return
    // 取 cookie 自己的 expiresAt 作为淘汰时刻；解析失败就按会话上限兜底。
    const payload = signingSecret === undefined
      ? undefined
      : verifyCookieValue(value, signingSecret, authority, sessionMaxAge)
    revokedUntil.set(value, payload?.expiresAt ?? Date.now() + sessionMaxAge)
    // 顺手清掉已过期的表项，避免 Map 随着退出次数增长。
    const now = Date.now()
    for (const [revoked, expiresAt] of revokedUntil) {
      if (expiresAt > now) continue
      revokedUntil.delete(revoked)
    }
  }

  /**
   * 吊销所有既有会话：把签名密钥记录**替换**成新的随机密钥。
   *
   * 不能"删掉再让 Connection 重建"：删掉之后如果 Connection 重启失败，这条
   * 记录就永久缺失，宿主下次激活会自己生成，但当前进程内所有 cookie 已经
   * 失效、而插件也没有可用密钥——表现为整个认证崩掉。
   * 改成原地写入新密钥：记录始终存在，宿主重启后会读到同一份新值。
   */
  const revokeAllSessions = async () => {
    const generated = encodeBase64Url(randomBytes(32))
    await ctx.credentials.modifyRecord(SIGNING_KEY, async (current) => {
      // 保留宿主写的 payload 形状，只换 secret。
      const payload = current?.kind === 'grant' && typeof current.payload === 'object' && current.payload !== null
        ? { ...current.payload, secret: generated }
        : { version: 1, secret: generated }
      return { kind: 'grant', payload }
    })
    const replaced = await readSecret()
    if (replaced !== undefined) signingSecret = replaced

    // 让 Connection 重新激活以加载新密钥；失败不影响正确性——本进程已经用
    // 新密钥自洽，只是宿主的 /api 面要等下次激活才跟上。
    const entry = connectionRow()
    if (entry?.fiber === undefined) {
      ctx.logger.warn('web-password-auth: connection row not found; the Host keeps the previous key until restart')
      return
    }
    try {
      await entry.fiber.restart()
    } catch (error) {
      ctx.logger.warn('web-password-auth: could not restart connection; the Host keeps the previous key until restart', error)
    }
  }

  /**
   * 解析 dist 的入口文件路径。
   *
   * 不能只从本插件目录解析：本插件通常以 `link:` 方式装在 workspace 之外，
   * 它的 `node_modules` 里没有 `@deepseek-ai/dsh-web-frontend`（那是宿主安装
   * 自带的包）。所以按顺序尝试多个锚点，命中即返回：
   *
   * 1. 本插件自己的解析链（插件与宿主包同处一棵 node_modules 树时命中）
   * 2. Loader 的 `baseUrl` 锚点（profile 启动时指向装配根，最可靠）
   * 3. `NODE_PATH` 与当前工作目录（宿主源码检出时的常见布局）
   *
   * 全部失败时返回 undefined，由调用方给出可读诊断，而不是白屏。
   * @returns {string|undefined} index.html 的绝对路径。
   */
  const resolveDistIndex = () => {
    const anchors = [import.meta.url]
    const baseUrl = ctx.baseUrl
    if (typeof baseUrl === 'string' && baseUrl !== '') {
      anchors.push(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
    }
    for (const dir of (process.env.NODE_PATH ?? '').split(pathDelimiter).filter(Boolean)) {
      anchors.push(join(dir, 'noop.js'))
    }
    anchors.push(join(process.cwd(), 'noop.js'))
    for (const anchor of anchors) {
      try {
        const require = createRequire(anchor)
        return join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'index.html')
      } catch {
        // 换下一个锚点。
      }
    }
    return undefined
  }

  /**
   * 把 index.html 发出去。静态资源不在这里处理，它们本来就由
   * `frontend-static` 公开提供。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @param {string} pathname - 请求路径（`/` 或 `/index.html`）。
   */
  const serveIndex = async (req, res, pathname) => {
    const distIndex = resolveDistIndex()
    if (distIndex === undefined) {
      sendText(res, 500, 'dsh-web-password-auth: the Web frontend package is not resolvable\n')
      return
    }
    let html
    try {
      html = ctx.webServer.renderIndex(await readFile(distIndex, 'utf8'))
        .replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="./">`)
    } catch (error) {
      ctx.logger.warn('web-password-auth: could not read the frontend index', error)
      sendText(res, 500, 'dsh-web-password-auth: the Web frontend is not built\n')
      return
    }
    res.writeHead(200, { 'cache-control': 'no-store', 'content-type': HTML_TYPE })
    res.end(req.method === 'HEAD' ? undefined : html)
    void pathname
  }

  /**
   * 当前是否已启用两步验证。
   * @returns {Promise<boolean>} 是否启用。
   */
  const totpEnabled = async () => {
    if (!totpAvailable) return false
    const record = await readTotpRecord()
    return record?.kind === 'grant' && record.payload?.enabled === true
  }

  /** @returns {Promise<boolean>} 是否已经设置过用户名与口令。 */
  const hasAccount = async () => (await readPasswordRecord()) !== undefined

  /**
   * 把处理器包成"异常不外泄"的形态：记录后回 500，绝不因单个坏请求崩掉进程。
   * @param {Function} fn - 实际处理器。
   * @returns {Function} 安全处理器。
   */
  const guard = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (error) {
      ctx.logger.warn('web-password-auth: request failed', error)
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendText(res, 500, 'internal error\n')
    }
  }

  // ── 给应用内设置面板用的 JSON API ────────────────────────────────────────
  //
  // 这些端点给浏览器里的 Client 插件调用。它们和 `/account` 那套表单路由共用
  // 同一份状态与同一套认证校验，只是收发 JSON 而不是 HTML。
  // 路径放在 `/web-auth/` 下，不用 `/api`：`/api` 是整个宿主 API 的认证围栏，
  // 而这里的认证判定由本插件自己做（同一套 cookie）。

  /**
   * 返回 JSON。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @param {number} status - 状态码。
   * @param {object} body - 可序列化对象。
   */
  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }


  /**
   * 一道共用的会话闸门：未登录直接 401 JSON。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @returns {Promise<boolean>} 已认证返回 true；否则已写好 401 并返回 false。
   */
  const requireSession = async (req, res) => {
    if (await isAuthenticated(req)) return true
    sendJson(res, 401, { ok: false, error: 'unauthenticated' })
    return false
  }

  /** `GET /web-auth/status`：设置面板用它渲染当前状态。 */
  const handleApiStatus = async (req, res) => {
    if (!await requireSession(req, res)) return
    const record = await readPasswordRecord()
    sendJson(res, 200, {
      ok: true,
      hasAccount: record !== undefined,
      username: record?.payload?.username ?? '',
      totpEnabled: await totpEnabled(),
      totpAvailable,
      sessionDays: effectiveDays,
      sessionDaysRequested: sessionDays,
      hostSessionDays: hostDays,
      minPasswordLength,
    })
  }

  /**
   * `POST /web-auth/setup`：在本机首次创建账户。
   *
   * 存在的理由：`dsh web` 打印的地址带 `?token=`，用户点开就已经是登录态，
   * 永远走不到 `/setup` 那个页面。没有这个端点，用令牌进来的人就再也无法
   * 建立密码账户——只能手动去掉 URL 里的令牌参数。
   *
   * 因此这里只允许"尚无账户"时写入，并且沿用 `bootstrapLoopbackOnly` 的本机限制。
   */
  const handleApiSetup = async (req, res) => {
    if (!await requireSession(req, res)) return
    if (await hasAccount()) {
      sendJson(res, 409, { ok: false, error: 'accountExists' })
      return
    }
    if (bootstrapLoopbackOnly && !isLoopback(req)) {
      sendJson(res, 403, { ok: false, error: 'setupLocalOnly' })
      return
    }
    const body = await readJsonBody(req)
    const username = normalizeUsername(body.username)
    if (username === undefined) {
      sendJson(res, 400, { ok: false, error: 'usernameInvalid' })
      return
    }
    const password = String(body.password ?? '')
    if (password.length < minPasswordLength) {
      sendJson(res, 400, { ok: false, error: 'passwordTooShort', minPasswordLength })
      return
    }
    if (password !== String(body.confirm ?? '')) {
      sendJson(res, 400, { ok: false, error: 'passwordsDoNotMatch' })
      return
    }
    // 再查一次：并发下两个人同时提交时，先到的那个胜出。
    if (await hasAccount()) {
      sendJson(res, 409, { ok: false, error: 'accountExists' })
      return
    }
    await ctx.credentials.modifyRecord(PASSWORD_KEY, async () => ({
      kind: 'grant',
      payload: { version: 1, username, password: hashPassword(password) },
    }))
    ctx.logger.info('web-password-auth: account created for %s (from the settings panel)', username)
    sendJson(res, 200, { ok: true, username })
  }

  /** `POST /web-auth/password`：改密码（改完吊销全部会话）。 */
  const handleApiPassword = async (req, res) => {
    if (!await requireSession(req, res)) return
    if (!await hasAccount()) {
      // 记录不存在时 modifyRecord 是空操作；静默返回成功会骗人。
      sendJson(res, 409, { ok: false, error: 'noAccount' })
      return
    }
    const body = await readJsonBody(req)
    const password = String(body.password ?? '')
    if (password.length < minPasswordLength) {
      sendJson(res, 400, { ok: false, error: 'passwordTooShort', minPasswordLength })
      return
    }
    if (password !== String(body.confirm ?? '')) {
      sendJson(res, 400, { ok: false, error: 'passwordsDoNotMatch' })
      return
    }
    await ctx.credentials.modifyRecord(PASSWORD_KEY, async (current) => {
      if (current?.kind !== 'grant') return undefined
      return { kind: 'grant', payload: { ...current.payload, password: hashPassword(password) } }
    })
    ctx.logger.info('web-password-auth: password changed from the settings panel; revoking all sessions')
    revokeSession(req)
    await revokeAllSessions()
    sendJson(res, 200, { ok: true, signedOut: true })
  }

  /** `POST /web-auth/username`：改用户名（面板调用）。 */
  const handleApiUsername = async (req, res) => {
    if (!await requireSession(req, res)) return
    if (!await hasAccount()) {
      // 记录不存在时 modifyRecord 是空操作；静默返回成功会骗人。
      sendJson(res, 409, { ok: false, error: 'noAccount' })
      return
    }
    const body = await readJsonBody(req)
    const username = normalizeUsername(body.username)
    if (username === undefined) {
      sendJson(res, 400, { ok: false, error: 'usernameInvalid' })
      return
    }
    await ctx.credentials.modifyRecord(PASSWORD_KEY, async (current) => {
      if (current?.kind !== 'grant') return undefined
      return { kind: 'grant', payload: { ...current.payload, username } }
    })
    ctx.logger.info('web-password-auth: username changed from the settings panel')
    sendJson(res, 200, { ok: true, username })
  }

  /** `POST /web-auth/totp/begin`：生成待确认密钥。 */
  const handleApiTotpBegin = async (req, res) => {
    if (!await requireSession(req, res)) return
    if (!totpAvailable) {
      sendJson(res, 400, { ok: false, error: 'totpUnavailable' })
      return
    }
    // 已经开启时必须走"验证码 → 关闭"的路径。否则一次 begin 就把记录覆盖成
    // 未启用状态，等于不需要验证码就关掉了两步验证。
    if (await totpEnabled()) {
      sendJson(res, 409, { ok: false, error: 'totpAlreadyEnabled' })
      return
    }
    const secret = generateTotpSecret()
    await ctx.credentials.modifyRecord(TOTP_KEY, async () => ({
      kind: 'grant',
      payload: { version: 1, secret, enabled: false, lastUsedCounter: 0 },
    }))
    const record = await readPasswordRecord()
    const username = record?.payload?.username ?? ''
    const uri = totpUri(secret, username, totpIssuer)
    sendJson(res, 200, { ok: true, secret, otpauthUri: uri, qrDataUri: await qrDataUri(uri) })
  }

  /** `POST /web-auth/totp/cancel`：丢弃尚未确认的开户草稿。 */
  const handleApiTotpCancel = async (req, res) => {
    if (!await requireSession(req, res)) return
    const record = await readTotpRecord()
    // 只清未启用的草稿；已开启的必须走 disable（需要验证码）。
    if (record?.kind === 'grant' && record.payload?.enabled !== true) {
      await ctx.credentials.deleteRecord(TOTP_KEY)
    }
    sendJson(res, 200, { ok: true })
  }

  /** `POST /web-auth/totp/confirm`：校验验证码后启用。 */
  const handleApiTotpConfirm = async (req, res) => {
    if (!await requireSession(req, res)) return
    const body = await readJsonBody(req)
    const record = await readTotpRecord()
    const used = verifyTotp(record?.payload?.secret, String(body.code ?? ''), record?.payload?.lastUsedCounter ?? 0)
    if (used === undefined) {
      sendJson(res, 400, { ok: false, error: 'wrongTotp' })
      return
    }
    await ctx.credentials.modifyRecord(TOTP_KEY, async (current) => {
      if (current?.kind !== 'grant') return undefined
      // 不消费时间窗：开户动作已由会话认证，消费会让紧接着的重新登录被判重放。
      return { kind: 'grant', payload: { ...current.payload, enabled: true } }
    })
    ctx.logger.info('web-password-auth: two-factor authentication enabled from the settings panel')
    sendJson(res, 200, { ok: true })
  }

  /** `POST /web-auth/totp/disable`：校验验证码后关闭。 */
  const handleApiTotpDisable = async (req, res) => {
    if (!await requireSession(req, res)) return
    const body = await readJsonBody(req)
    const record = await readTotpRecord()
    const used = verifyTotp(record?.payload?.secret, String(body.code ?? ''), record?.payload?.lastUsedCounter ?? 0)
    if (used === undefined) {
      sendJson(res, 400, { ok: false, error: 'wrongTotp' })
      return
    }
    await ctx.credentials.deleteRecord(TOTP_KEY)
    ctx.logger.info('web-password-auth: two-factor authentication disabled from the settings panel')
    sendJson(res, 200, { ok: true })
  }

  /** `POST /web-auth/logout`：吊销当前会话。 */
  const handleApiLogout = async (req, res) => {
    if (!await requireSession(req, res)) return
    revokeSession(req)
    const authority = requestAuthority(req.headers, secure())
    if (authority !== undefined) revokeCookie(res, authority)
    sendJson(res, 200, { ok: true })
  }

  /**
   * `GET /` 与 `/index.html`：三态分派。
   * 带 `?token=` 的请求必须原样交给宿主，否则会打断 `dsh web` 的启动引导。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   */
  const handleRoot = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    // 必须是第一个判断：带 token 时宿主自己写 303，接管这里会破坏令牌交换。
    if (url.searchParams.has('token') || await isAuthenticated(req)) {
      if (!ctx.connection.authorizeIndex(req, res)) return
      await serveIndex(req, res, url.pathname)
      return
    }
    const t = stringsFor(localeOf(req))
    const record = await readPasswordRecord()
    if (record === undefined) {
      sendHtml(res, 200, renderSetupPage({ t }))
      return
    }
    sendHtml(res, 200, renderLoginPage({
      t,
      username: record.payload?.username ?? '',
      needsTotp: await totpEnabled(),
    }))
  }

  /**
   * `POST /setup`：创建账户，仅当尚无口令记录时可用。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   */
  const handleSetup = async (req, res) => {
    const t = stringsFor(localeOf(req))
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', location: './login' })
      res.end()
      return
    }
    if (await readPasswordRecord() !== undefined) {
      redirect(res, './login')
      return
    }
    if (bootstrapLoopbackOnly && !isLoopback(req)) {
      sendHtml(res, 403, renderErrorPage({ t, status: 403, message: t.setupLocalOnly }))
      return
    }
    const form = await readForm(req)
    // 与面板里的改名走同一条校验规则，避免出现"能建、不能改"的不一致。
    const username = normalizeUsername(form.username)
    const password = form.password ?? ''
    if (username === undefined) return sendHtml(res, 400, renderSetupPage({ t, error: 'usernameInvalid' }))
    if (password.length < minPasswordLength) return sendHtml(res, 400, renderSetupPage({ t, error: 'passwordTooShort' }))
    if (password !== (form.confirm ?? '')) return sendHtml(res, 400, renderSetupPage({ t, error: 'passwordsDoNotMatch' }))

    await ctx.credentials.modifyRecord(PASSWORD_KEY, async () => ({
      kind: 'grant',
      payload: { version: 1, username, password: hashPassword(password) },
    }))
    ctx.logger.info('web-password-auth: account created for %s', username)

    const authority = requestAuthority(req.headers, secure())
    if (authority !== undefined) await issueCookie(res, authority)
    redirect(res, './')
  }

  /**
   * `GET /login` 显示表单，`POST /login` 校验凭据。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   */
  const handleLogin = async (req, res) => {
    const t = stringsFor(localeOf(req))
    if (req.method === 'GET') {
      const record = await readPasswordRecord()
      if (record === undefined) {
        redirect(res, './')
        return
      }
      sendHtml(res, 200, renderLoginPage({
        t,
        username: record.payload?.username ?? '',
        needsTotp: await totpEnabled(),
      }))
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
      return
    }

    const source = sourceKey(req)
    const state = limiter.check(source)
    if (state.locked) {
      sendHtml(res, 429, renderLoginPage({
        t,
        error: 'lockedOut',
        errorParams: { minutes: String(Math.ceil(state.remainingMs / 60_000)) },
        needsTotp: await totpEnabled(),
      }))
      return
    }

    const form = await readForm(req)
    const record = await readPasswordRecord()
    const storedName = String(record?.payload?.username ?? '')
    const userOk = record !== undefined
      && String(form.username ?? '').trim().toLowerCase() === storedName.toLowerCase()
    const passOk = userOk && verifyPassword(form.password ?? '', record.payload?.password)

    // 无论成败都等一个固定下限，避免用响应时间区分"用户名错"和"密码错"。
    if (!userOk || !passOk) {
      limiter.fail(source)
      await delay(MIN_FAILURE_DELAY_MS)
      sendHtml(res, 401, renderLoginPage({
        t,
        error: 'wrongCredentials',
        username: String(form.username ?? ''),
        needsTotp: await totpEnabled(),
      }))
      return
    }

    if (await totpEnabled()) {
      const totpRecord = await readTotpRecord()
      const lastUsed = totpRecord?.payload?.lastUsedCounter ?? 0
      const used = verifyTotp(totpRecord?.payload?.secret, String(form.totp ?? ''), lastUsed)
      if (used === undefined) {
        limiter.fail(source)
        await delay(MIN_FAILURE_DELAY_MS)
        sendHtml(res, 401, renderLoginPage({
          t, error: 'wrongTotp', username: storedName, needsTotp: true,
        }))
        return
      }
      // 记下已用时间步，杜绝同一验证码重放。
      await ctx.credentials.modifyRecord(TOTP_KEY, async (current) => {
        if (current?.kind !== 'grant') return undefined
        return { kind: 'grant', payload: { ...current.payload, lastUsedCounter: used } }
      })
    }

    limiter.reset(source)
    const authority = requestAuthority(req.headers, secure())
    if (authority === undefined || !await issueCookie(res, authority)) {
      sendText(res, 500, 'dsh-web-password-auth: cannot establish a session (signing key unavailable)\n')
      return
    }
    redirect(res, './')
  }

  /**
   * `POST /logout`：清 cookie 后回登录页。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   */
  const handleLogout = async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    // 只清 cookie 不够：服务端也要记住这一条已作废，否则被复制的 cookie 依然可用。
    revokeSession(req)
    const authority = requestAuthority(req.headers, secure())
    if (authority !== undefined) revokeCookie(res, authority)
    redirect(res, './login')
  }

  // ── 注册 ─────────────────────────────────────────────────────────────────

  ctx.effect(() => {
    const routes = [
      // 精确路由优先于 fallback：这两个必须抢在 frontend-static 的 401 之前。
      ['/', handleRoot],
      ['/index.html', handleRoot],
      ['/login', handleLogin],
      ['/logout', handleLogout],
      ['/setup', handleSetup],
      // 账户管理全部在应用内的「设置 → 安全」面板完成，这里不再提供独立账户页。
      // 下面这些 JSON 端点只服务那个面板，靠同一个会话 cookie 认证。
      ['/web-auth/status', handleApiStatus],
      ['/web-auth/setup', handleApiSetup],
      ['/web-auth/password', handleApiPassword],
      ['/web-auth/username', handleApiUsername],
      ['/web-auth/totp/begin', handleApiTotpBegin],
      ['/web-auth/totp/confirm', handleApiTotpConfirm],
      ['/web-auth/totp/disable', handleApiTotpDisable],
      ['/web-auth/totp/cancel', handleApiTotpCancel],
      ['/web-auth/logout', handleApiLogout],
    ]
    const disposers = routes.map(([path, fn]) =>
      ctx.webServer.register({ kind: 'exact', path, handler: guard(fn) }))
    return () => { for (const dispose of disposers) dispose() }
  }, 'web-password-auth: routes')

  // 激活时取一次密钥并做形状校验。形状不符说明宿主换了格式，必须响亮报错，
  // 否则症状是"密码永远输不对"，极难排查。
  ctx.effect(() => {
    let cancelled = false
    void (async () => {
      const secret = await readSecret().catch((error) => {
        ctx.logger.error('web-password-auth: reading the signing key failed', error)
        return undefined
      })
      if (cancelled) return
      if (secret === undefined) {
        ctx.logger.error(
          'web-password-auth: the "%s" signing key is missing or has an unexpected shape; '
          + 'password login is disabled. The upstream cookie format most likely changed — update this plugin.',
          SIGNING_KEY,
        )
        return
      }
      signingSecret = secret
      // 自检：签一个 cookie 再自验，确认与宿主的格式约定仍然成立。
      const now = Date.now()
      const probe = mintCookieValue(secret, 'self-check', now, now + 60_000)
      if (verifyCookieValue(probe, secret, 'self-check', 60_000, now) === undefined) {
        ctx.logger.error('web-password-auth: cookie self-check failed; password login will not work')
        return
      }
      ctx.logger.info('web-password-auth: ready (%s day sessions, two-factor %s)',
        String(effectiveDays), totpAvailable ? 'available' : 'off')
    })()
    return () => { cancelled = true }
  }, 'web-password-auth: signing secret')
}
