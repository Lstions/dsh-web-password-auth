/**
 * crypto.js —— 本插件全部的密码学操作，无 Cordis 依赖，便于独立测试。
 *
 * 三块内容：
 * 1. cookie 的签发与解析：必须与宿主 `dsh-client-connection` 的 `BrowserAuth`
 *    逐字节兼容，否则签出来的 cookie 会被校验拒绝（实测：形状不对一律 401）。
 * 2. 密码哈希：scrypt，参数随记录一起存，将来可以升级。
 * 3. TOTP：RFC 6238，已用官方测试向量验证。
 */

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

// ── cookie 格式常量：必须与 browser-auth.ts 保持一致 ────────────────────────
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_VERSION = 'v1'
const SECRET_BYTES = 32
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000

/** base64url 编码，无填充，`+`→`-`，`/`→`_`（对齐 browser-auth.ts:47-52）。 */
export function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

/** base64url 解码；非法字符或长度异常返回 undefined。 */
export function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) return undefined
  if (value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  // 往返比对，排除 base64 宽松解码把垃圾读成有效字节。
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

/**
 * cookie 名字：`dsh-auth-` + base64url(sha256(authority))。
 * 与 browser-auth.ts:116-118 一致；authority 绑定让同一个 home 在不同端口
 * 上互不干扰。
 * @param {string} authority - `host:port`（HTTP）或 `origin`（HTTPS）。
 * @returns {string} cookie 名。
 */
export function cookieName(authority) {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/**
 * 请求对应的 cookie audience。
 * HTTP 用 `Host` 头原样（host:port）；HTTPS 用 origin（带 scheme）。
 * 对齐 browser-auth.ts:78-88。
 * @param {object} headers - node:http 请求头。
 * @param {boolean} secure - 监听器是否服务 TLS。
 * @returns {string|undefined} authority，Host 缺失或不可解析时 undefined。
 */
export function requestAuthority(headers, secure) {
  const host = headers?.host
  if (typeof host !== 'string' || host === '') return undefined
  try {
    const url = new URL(`${secure ? 'https:' : 'http:'}//${host}`)
    return secure ? url.origin : url.host
  } catch {
    return undefined
  }
}

/**
 * 签发一个浏览器会话 cookie 值。
 *
 * payload 与 browser-auth.ts:29-34 完全相同；签名覆盖的是我们自己生成的
 * body 字符串，所以 JSON 键序不影响校验结果（宿主是先验签再 parse）。
 * @param {Buffer} secret - 32 字节 HMAC 密钥。
 * @param {string} authority - 请求 audience。
 * @param {number} issuedAt - 签发时刻（毫秒）。
 * @param {number} expiresAt - 过期时刻（毫秒）。
 * @returns {string} cookie 值（含 `v1.` 前缀）。
 */
export function mintCookieValue(secret, authority, issuedAt, expiresAt) {
  const payload = { version: 1, authority, issuedAt, expiresAt }
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = encodeBase64Url(createHmac('sha256', secret).update(body).digest())
  return `${COOKIE_VERSION}.${body}.${signature}`
}

/**
 * 解析并验签一个 cookie 值。用于插件自己判断"当前请求是否已登录"，
 * 语义与 BrowserAuth.authenticate 保持一致（含有效期上限检查）。
 * @param {string} value - cookie 值。
 * @param {Buffer} secret - HMAC 密钥。
 * @param {string} authority - 期望的 audience。
 * @param {number} maxAgeMilliseconds - 允许的最大有效期跨度。
 * @param {number} now - 当前时刻（毫秒），便于测试注入。
 * @returns {object|undefined} 负载，任何一项不满足时 undefined。
 */
export function verifyCookieValue(value, secret, authority, maxAgeMilliseconds, now = Date.now()) {
  if (typeof value !== 'string') return undefined
  const parts = value.split('.')
  if (parts.length !== 3) return undefined
  const [version, body, encodedSignature] = parts
  if (version !== COOKIE_VERSION || body === undefined || encodedSignature === undefined) return undefined

  const actual = decodeBase64Url(encodedSignature)
  if (actual === undefined) return undefined
  const expected = createHmac('sha256', secret).update(body).digest()
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return undefined

  const bodyBytes = decodeBase64Url(body)
  if (bodyBytes === undefined) return undefined
  let payload
  try {
    payload = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  if (payload.version !== 1) return undefined
  if (typeof payload.authority !== 'string' || payload.authority !== authority) return undefined
  if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)) return undefined
  if (payload.issuedAt > now || payload.expiresAt <= now) return undefined
  if (payload.expiresAt <= payload.issuedAt) return undefined
  if (payload.expiresAt - payload.issuedAt > maxAgeMilliseconds) return undefined
  return payload
}

/** 从 Cookie 头里取指定名字的值；只认我们生成的那个名字。 */
export function readCookieValue(headerValue, name) {
  if (typeof headerValue !== 'string') return undefined
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/**
 * 序列化 Set-Cookie 属性，与 browser-auth.ts:131-140 一致。
 * @param {string} name - cookie 名。
 * @param {string} value - cookie 值；空串表示删除。
 * @param {{expiresAt?: number, maxAgeSeconds: number, secure: boolean}} options - 属性。
 * @returns {string} Set-Cookie 头值。
 */
export function sessionCookie(name, value, { expiresAt, maxAgeSeconds, secure }) {
  const parts = [`${name}=${value}`, `Max-Age=${String(maxAgeSeconds)}`, 'Path=/']
  if (expiresAt !== undefined) parts.push(`Expires=${new Date(expiresAt).toUTCString()}`)
  parts.push('HttpOnly', 'SameSite=Strict')
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** 清除一个 cookie：同名、空值、立即过期。 */
export function clearCookie(name, secure) {
  return sessionCookie(name, '', { maxAgeSeconds: 0, expiresAt: 0, secure })
}

// ── 密码哈希 ────────────────────────────────────────────────────────────────

/** 默认 scrypt 参数。实测 N=32768 约 66ms / 32MB，足以抗爆破又不拖慢登录。 */
export const SCRYPT_DEFAULTS = { N: 32768, r: 8, p: 1, keylen: 32, saltBytes: 16 }

/**
 * 计算密码哈希。
 * `maxmem` 必须显式给到 128*N*r 以上，否则 Node 默认 32MB 上限会在 N=65536 时报
 * ERR_CRYPTO_INVALID_SCRYPT_PARAMS。
 * @param {string} password - 明文密码。
 * @param {object} [params] - 覆盖默认 scrypt 参数。
 * @returns {{algo: string, N: number, r: number, p: number, salt: string, hash: string}} 可持久化的字段。
 */
export function hashPassword(password, params = {}) {
  const { N, r, p, keylen, saltBytes } = { ...SCRYPT_DEFAULTS, ...params }
  const salt = randomBytes(saltBytes)
  const derived = scryptSync(Buffer.from(password, 'utf8'), salt, keylen, {
    N, r, p, maxmem: Math.max(128 * N * r * 2, 64 * 1024 * 1024),
  })
  return { algo: 'scrypt', N, r, p, salt: encodeBase64Url(salt), hash: encodeBase64Url(derived) }
}

/**
 * 校验密码。长度不等时直接返回 false，不进入 timingSafeEqual（它要求等长缓冲区）。
 * @param {string} password - 用户输入。
 * @param {object} record - {@link hashPassword} 的结果。
 * @returns {boolean} 是否匹配。
 */
export function verifyPassword(password, record) {
  if (typeof password !== 'string' || typeof record !== 'object' || record === null) return false
  if (record.algo !== 'scrypt') return false
  const salt = decodeBase64Url(record.salt)
  const expected = decodeBase64Url(record.hash)
  if (salt === undefined || expected === undefined) return false
  let derived
  try {
    derived = scryptSync(Buffer.from(password, 'utf8'), salt, expected.byteLength, {
      N: record.N, r: record.r, p: record.p,
      maxmem: Math.max(128 * record.N * record.r * 2, 64 * 1024 * 1024),
    })
  } catch {
    // 参数非法或密码超长导致 scrypt 失败：一律视为不匹配，不向上抛。
    return false
  }
  return derived.byteLength === expected.byteLength && timingSafeEqual(derived, expected)
}

// ── TOTP（RFC 6238）─────────────────────────────────────────────────────────

/** base32 字母表（RFC 4648，TOTP 约定的形式）。 */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * 生成一个 20 字节（160 位）的 TOTP 密钥，base32 编码。
 * 160 位是 RFC 4226 为 HMAC-SHA1 推荐的长度，兼容性最好。
 * @returns {string} base32 密钥，无填充。
 */
export function generateTotpSecret() {
  return encodeBase32(randomBytes(20))
}

/** RFC 4648 base32 编码，无填充。 */
export function encodeBase32(buffer) {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31]
  return output
}

/** RFC 4648 base32 解码；非法字符返回 undefined。 */
export function decodeBase32(text) {
  if (typeof text !== 'string') return undefined
  const clean = text.toUpperCase().replaceAll('=', '').replaceAll(' ', '')
  let bits = 0
  let value = 0
  const bytes = []
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index === -1) return undefined
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/**
 * 计算某一时间步的 6 位验证码。
 * @param {Buffer} secret - 原始密钥字节。
 * @param {number} counter - 时间步（Unix 秒 / 30）。
 * @returns {string} 6 位数字。
 */
export function totpAt(secret, counter) {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', secret).update(buffer).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const binary = ((mac[offset] & 0x7f) << 24)
    | (mac[offset + 1] << 16)
    | (mac[offset + 2] << 8)
    | mac[offset + 3]
  return String(binary % 1_000_000).padStart(6, '0')
}

/** 当前时间对应的时间步。 */
export function totpCounter(now = Date.now()) {
  return Math.floor(now / 30_000)
}

/**
 * 校验验证码。接受 ±1 个时间窗以容忍时钟漂移，并拒绝重放
 * （`lastUsedCounter` 及更早的时间步一律不认）。
 * @param {string} secretBase32 - base32 密钥。
 * @param {string} code - 用户输入的 6 位数字。
 * @param {number} lastUsedCounter - 上次成功使用的时间步，0 表示从未用过。
 * @param {number} now - 当前时刻（毫秒）。
 * @returns {number|undefined} 成功时返回本次使用的时间步，失败 undefined。
 */
export function verifyTotp(secretBase32, code, lastUsedCounter, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return undefined
  const secret = decodeBase32(secretBase32)
  if (secret === undefined || secret.byteLength === 0) return undefined
  const counter = totpCounter(now)
  const supplied = Buffer.from(code, 'utf8')
  for (const candidate of [counter - 1, counter, counter + 1]) {
    if (candidate <= lastUsedCounter) continue
    const expected = Buffer.from(totpAt(secret, candidate), 'utf8')
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) return candidate
  }
  return undefined
}

/** 生成 otpauth:// URI，供验证器 App 手动录入。 */
export function totpUri(secretBase32, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return `otpauth://totp/${label}?${params.toString()}`
}

// ── 密钥解析 ────────────────────────────────────────────────────────────────

/**
 * 从凭据记录里取出 32 字节签名密钥。
 * 记录形状由 browser-auth.ts:182-199 决定：`{kind:'grant', payload:{version:1, secret}}`。
 * @param {object|undefined} record - `ctx.credentials.readRecord` 的返回值。
 * @returns {Buffer|undefined} 密钥，形状不符时 undefined（调用方应报错而非猜测）。
 */
export function parseSigningSecret(record) {
  if (typeof record !== 'object' || record === null || record.kind !== 'grant') return undefined
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null || payload.version !== 1) return undefined
  const secret = decodeBase64Url(payload.secret)
  if (secret === undefined || secret.byteLength !== SECRET_BYTES) return undefined
  return secret
}

export { DAY_MILLISECONDS, SECRET_BYTES }
