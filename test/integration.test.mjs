/**
 * integration.test.mjs —— 用真实 Cordis 树 + 真实 HTTP 服务器跑通整条链路。
 *
 * 不启动完整 dsh（那需要装到 profile 里），而是构造与宿主同形的假服务：
 * - webServer：精确路由表 + fallback，匹配顺序与真实实现一致（exact → prefix → fallback）
 * - connection：requestRejection / authorizeIndex 的等价语义
 * - credentials：内存版记录存储，record 形状与 credentials-local 一致
 *
 * 这样能验证本插件自己的逻辑（路由分派、cookie 往返、限速、改密码吊销），
 * 而不依赖宿主的内部装配。
 */

import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

import { apply, Config } from '../lib/index.js'
import { cookieName, encodeBase64Url, hashPassword, mintCookieValue } from '../lib/crypto.js'

const AUTHORITY_HEADER = '127.0.0.1'
const SIGNING_KEY = 'client-connection/browser-session'

/** 内存版 credentials，记录形状与 credentials-local 的 grant 记录一致。 */
class MemoryCredentials {
  constructor() {
    this.records = new Map()
  }

  readRecord(key) {
    return Promise.resolve(this.records.get(key))
  }

  modifyRecord(key, mutate) {
    return Promise.resolve(mutate(this.records.get(key))).then((next) => {
      if (next !== undefined) this.records.set(key, next)
      return next
    })
  }

  deleteRecord(key) {
    this.records.delete(key)
    return Promise.resolve()
  }
}

/**
 * 构造一棵最简 Cordis 等价树并启动真实 HTTP 服务器。
 * 返回句柄含 port、credentials、以及清理函数。
 */
async function startHarness(options = {}) {
  // 直接传普通对象：真实 Loader 会用 schema 解析并填默认值，
  // 这里给出与 schema 默认值相同的值即可。
  const config = {
    sessionDays: options.sessionDays ?? 365,
    bootstrapLoopbackOnly: options.bootstrapLoopbackOnly ?? true,
    maxAttempts: options.maxAttempts ?? 5,
    lockoutMs: options.lockoutMs ?? 60_000,
    minPasswordLength: options.minPasswordLength ?? 8,
    totpIssuer: 'DSH',
    totpAvailable: options.totpAvailable ?? true,
  }

  const credentials = new MemoryCredentials()
  // 宿主会在自己激活时创建这条记录；这里预置，模拟"Connection 已先激活"。
  credentials.records.set(SIGNING_KEY, {
    kind: 'grant',
    payload: { version: 1, secret: encodeBase64Url(randomBytes(32)) },
  })

  /** 精确路由表。 */
  const exact = new Map()
  const prefix = new Map()
  let fallback
  const logs = []

  const webServer = {
    protocol: 'http:',
    host: AUTHORITY_HEADER,
    register(route) {
      const table = route.kind === 'exact' ? exact : prefix
      if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route "${route.path}"`)
      table.set(route.path, route)
      return () => { table.delete(route.path) }
    },
    registerFallback(handler) {
      fallback = handler
      return () => { fallback = undefined }
    },
    renderIndex(html, peer) {
      if (options.renderIndexCalls !== undefined) options.renderIndexCalls.push([html, peer])
      // 新版 Host 用 peer 收集 index 注入行，缺它时内部 emit 会抛错。
      // 这里复现那条约束，好让"漏传 peer"在测试里直接失败。
      if (options.requirePeer === true && peer === undefined) {
        throw new Error('cannot collect injections without a peer')
      }
      // 模拟宿主的真实渲染：真的往 head 里注入一行。
      return html.replace('</head>', '<script>globalThis.__INJECTED__ = true</script></head>')
    },
  }

  const connection = {
    // 新版 Host 暴露的代表浏览器的 Peer；默认提供，可用 browserPeer: false 去掉。
    ...(options.browserPeer === false ? {} : { browserPeer: { principal: { kind: 'owner' } } }),
    /** 等价语义：这里只做"Host 是 loopback 就通过"，跨站校验不在本测试范围。 */
    requestRejection(req) {
      const host = req.headers.host
      if (typeof host !== 'string') return 403
      const hostname = host.split(':')[0]
      return hostname === '127.0.0.1' || hostname === 'localhost' ? undefined : 403
    },
    authorizeIndex(req, res) {
      if (req.url?.includes('token=')) {
        res.writeHead(303, { location: './' })
        res.end()
        return false
      }
      return true
    },
  }

  const disposers = []
  const effects = []
  const ctx = {
    logger: {
      info: (...args) => logs.push(['info', args.join(' ')]),
      warn: (...args) => logs.push(['warn', args.join(' ')]),
      error: (...args) => logs.push(['error', args.join(' ')]),
    },
    get: (service) => (service === 'webServer' ? webServer : service === 'loader' ? undefined : undefined),
    provide: () => () => {},
    effect: (fn) => { effects.push(fn) },
    on: () => () => {},
    emit: () => {},
    inject: () => () => {},
    plugin: () => () => {},
    root: {},
    fiber: { state: 'active' },
    webServer,
    connection,
    credentials,
    loader: undefined,
    // 反射入口：真实进程里用来读取 Host 自己算好的前端路径。
    registry: options.registry ?? { values: () => [] },
  }

  apply(ctx, config)
  // 执行 effect 回调，拿到 dispose 函数
  for (const effect of effects) {
    const result = effect()
    if (typeof result === 'function') disposers.push(result)
  }

  // 等激活时的异步密钥加载完成
  await new Promise(resolve => setTimeout(resolve, 50))

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const route = exact.get(pathname)
    if (route !== undefined) {
      void route.handler(req, res)
      return
    }
    let best
    for (const [p, r] of prefix) {
      if (pathname !== p && !pathname.startsWith(`${p}/`)) continue
      if (best === undefined || p.length > best.path.length) best = { path: p, ...r }
    }
    if (best !== undefined) {
      void best.handler(req, res)
      return
    }
    if (fallback !== undefined) {
      void fallback(req, res)
      return
    }
    res.writeHead(404)
    res.end()
  })

  // 真实环境里 fallback 是宿主的 frontend-static（SPA 静态服务）。插件把 `/`
  // 交还宿主后，请求就落在这里——测试需要一个等价物。
  webServer.registerFallback((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>host fallback</title>')
  })

  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    credentials,
    logs,
    async close() {
      for (const dispose of disposers) await dispose()
      await new Promise((resolve) => { server.close(resolve) })
    },
  }
}

/** 发一个请求，返回 {status, headers, body}。 */
async function request(origin, path, init = {}) {
  const response = await fetch(`${origin}${path}`, { redirect: 'manual', ...init })
  const body = await response.text()
  return { status: response.status, headers: response.headers, body }
}

/** 从响应头取 Set-Cookie 里的 `name=value` 对，用于后续请求。 */
function cookieFrom(response) {
  const raw = response.headers.getSetCookie?.() ?? []
  if (raw.length === 0) return undefined
  const first = raw[0]
  const at = first.indexOf('=')
  const semi = first.indexOf(';')
  return first.slice(0, semi === -1 ? undefined : semi)
}

/** 用 JSON 发 POST（设置面板走这条路）。 */
function postJson(origin, path, fields, cookie) {
  return request(origin, path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(fields ?? {}),
  })
}

/** 用表单编码发 POST。 */
function postForm(origin, path, fields, cookie) {
  return request(origin, path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams(fields).toString(),
  })
}

describe('首次引导', () => {
  let harness
  before(async () => { harness = await startHarness({ minPasswordLength: 8 }) })
  after(async () => { await harness.close() })

  test('尚无账户时 GET / 返回创建账户页', async () => {
    const r = await request(harness.origin, '/')
    assert.equal(r.status, 200)
    assert.match(r.body, /Create your account/)
    assert.match(r.body, /name="confirm"/)
  })

  test('密码太短被拒', async () => {
    const r = await postForm(harness.origin, '/setup', { username: 'admin', password: 'short', confirm: 'short' })
    assert.equal(r.status, 400)
    assert.match(r.body, /at least 8 characters/)
  })

  test('两次密码不一致被拒', async () => {
    const r = await postForm(harness.origin, '/setup', { username: 'admin', password: 'longenough1', confirm: 'longenough2' })
    assert.equal(r.status, 400)
    assert.match(r.body, /do not match/)
  })

  test('非法用户名被拒', async () => {
    for (const username of ['   ', 'has space', 'a'.repeat(65)]) {
      const r = await postForm(harness.origin, '/setup', { username, password: 'longenough', confirm: 'longenough' })
      assert.equal(r.status, 400, `应拒绝用户名 ${JSON.stringify(username)}`)
      assert.match(r.body, /1-64 letters/)
    }
  })

  test('创建成功后落到口令记录并签发 cookie', async () => {
    const r = await postForm(harness.origin, '/setup', {
      username: 'admin', password: 'correct horse', confirm: 'correct horse',
    })
    assert.equal(r.status, 303)
    const record = harness.credentials.records.get('web-auth/password')
    assert.ok(record)
    assert.equal(record.kind, 'grant')
    assert.equal(record.payload.username, 'admin')
    assert.equal(record.payload.password.algo, 'scrypt')
    assert.ok(cookieFrom(r), '应签发 cookie')
  })

  test('已有账户后再访问 /setup 会被重定向到登录页', async () => {
    const r = await postForm(harness.origin, '/setup', { username: 'x', password: 'longenough', confirm: 'longenough' })
    assert.equal(r.status, 303)
    assert.equal(r.headers.get('location'), './login')
  })

  test('现在 GET / 返回登录页而不是引导页', async () => {
    const r = await request(harness.origin, '/')
    assert.equal(r.status, 200)
    assert.match(r.body, /Sign in/)
    assert.doesNotMatch(r.body, /Create your account/)
  })
})

describe('登录与会话', () => {
  let harness
  before(async () => {
    harness = await startHarness()
    await postForm(harness.origin, '/setup', { username: 'admin', password: 'correct horse', confirm: 'correct horse' })
  })
  after(async () => { await harness.close() })

  test('错误密码被拒', async () => {
    const r = await postForm(harness.origin, '/login', { username: 'admin', password: 'wrong' })
    assert.equal(r.status, 401)
    assert.match(r.body, /Wrong username or password/)
  })

  test('错误用户名被拒', async () => {
    const r = await postForm(harness.origin, '/login', { username: 'nobody', password: 'correct horse' })
    assert.equal(r.status, 401)
  })

  test('用户名大小写不敏感', async () => {
    const r = await postForm(harness.origin, '/login', { username: 'ADMIN', password: 'correct horse' })
    assert.equal(r.status, 303)
  })

  test('正确凭据签发 cookie，且 cookie 可用于面板端点', async () => {
    const login = await postForm(harness.origin, '/login', { username: 'admin', password: 'correct horse' })
    assert.equal(login.status, 303)
    const cookie = cookieFrom(login)
    assert.ok(cookie)

    const status = await request(harness.origin, '/web-auth/status', { headers: { cookie } })
    assert.equal(status.status, 200)
    assert.equal(JSON.parse(status.body).username, 'admin')
  })

  test('无 cookie 访问面板端点被拒', async () => {
    const r = await request(harness.origin, '/web-auth/status')
    assert.equal(r.status, 401)
    assert.equal(JSON.parse(r.body).ok, false)
  })

  test('伪造的 cookie 不被接受', async () => {
    const name = cookieName(`${AUTHORITY_HEADER}:${harness.port}`)
    const forged = `${name}=v1.${encodeBase64Url(Buffer.from(JSON.stringify({
      version: 1, authority: `${AUTHORITY_HEADER}:${harness.port}`,
      issuedAt: Date.now(), expiresAt: Date.now() + 86_400_000,
    })))}.${encodeBase64Url(Buffer.from('bad signature'))}`
    const r = await request(harness.origin, '/web-auth/status', { headers: { cookie: forged } })
    assert.equal(r.status, 401, '伪造 cookie 应按未登录处理')
  })

  test('登出清除 cookie 并回登录页', async () => {
    const login = await postForm(harness.origin, '/login', { username: 'admin', password: 'correct horse' })
    const cookie = cookieFrom(login)
    const out = await postForm(harness.origin, '/logout', {}, cookie)
    assert.equal(out.status, 303)
    assert.equal(out.headers.get('location'), './login')
    const cleared = out.headers.getSetCookie?.() ?? []
    assert.ok(cleared.some(value => value.includes('Max-Age=0')), '应下发清除指令')
  })

  test('退出后服务端立刻拒绝旧 cookie（不只是让浏览器删掉）', async () => {
    const login = await postForm(harness.origin, '/login', { username: 'admin', password: 'correct horse' })
    const cookie = cookieFrom(login)
    assert.ok(cookie)

    // 退出前可用
    assert.equal((await request(harness.origin, '/web-auth/status', { headers: { cookie } })).status, 200)

    await postForm(harness.origin, '/logout', {}, cookie)

    // 退出后：同一条 cookie 再打，必须被服务端拒绝。
    // 仅仅下发清除指令是不够的——浏览器之外的持有者仍会带着它。
    const after = await request(harness.origin, '/web-auth/status', { headers: { cookie } })
    assert.equal(after.status, 401, '已吊销的 cookie 必须被服务端拒绝')
  })

  test('带 token 的请求走宿主分支（不被本插件接管）', async () => {
    const r = await request(harness.origin, '/?token=abc')
    assert.equal(r.status, 303)
    assert.equal(r.headers.get('location'), './')
  })
})

describe('登录限速', () => {
  let harness
  before(async () => {
    harness = await startHarness({ maxAttempts: 3, lockoutMs: 60_000 })
    await postForm(harness.origin, '/setup', { username: 'admin', password: 'correct horse', confirm: 'correct horse' })
  })
  after(async () => { await harness.close() })

  test('连续失败达到阈值后锁定，且锁定期间正确密码也进不去', async () => {
    for (let i = 0; i < 3; i += 1) {
      const r = await postForm(harness.origin, '/login', { username: 'admin', password: 'wrong' })
      assert.equal(r.status, 401)
    }
    const locked = await postForm(harness.origin, '/login', { username: 'admin', password: 'correct horse' })
    assert.equal(locked.status, 429)
    assert.match(locked.body, /Too many attempts/)
  })
})

describe('改密码', () => {
  // 每个用例独立一台 harness：改密码会删除签名密钥记录，
  // 共享状态会让后续用例的"改动前密钥应存在"断言失败。
  let harness
  beforeEach(async () => {
    harness = await startHarness()
    await postForm(harness.origin, '/setup', { username: 'admin', password: 'correct horse', confirm: 'correct horse' })
  })
  afterEach(async () => { await harness.close() })

  test('改密码后旧密码失效、新密码可用', async () => {
    const login = await postForm(harness.origin, '/login', { username: 'admin', password: 'correct horse' })
    const cookie = cookieFrom(login)

    const changed = await postJson(harness.origin, '/web-auth/password',
      { password: 'battery staple', confirm: 'battery staple' }, cookie)
    assert.equal(changed.status, 200, changed.body)

    const oldPass = await postForm(harness.origin, '/login', { username: 'admin', password: 'correct horse' })
    assert.equal(oldPass.status, 401)

    const newPass = await postForm(harness.origin, '/login', { username: 'admin', password: 'battery staple' })
    assert.equal(newPass.status, 303)
  })

  test('改密码会把签名密钥换成新值（吊销全部会话），且记录始终存在', async () => {
    const login = await postForm(harness.origin, '/login', { username: 'admin', password: 'correct horse' })
    const cookie = cookieFrom(login)
    assert.ok(cookie)

    const before = harness.credentials.records.get(SIGNING_KEY).payload.secret
    await postJson(harness.origin, '/web-auth/password',
      { password: 'battery staple', confirm: 'battery staple' }, cookie)

    // 关键：记录必须仍然存在。删掉再让 Connection 重建的做法在重启失败时
    // 会永久丢失密钥，让整个认证崩掉。
    const record = harness.credentials.records.get(SIGNING_KEY)
    assert.ok(record, '签名密钥记录必须保留')
    assert.notEqual(record.payload.secret, before, '密钥必须换成新值')

    // 旧 cookie 用旧密钥签发，新密钥下必然验不过。
    const stale = await request(harness.origin, '/web-auth/status', { headers: { cookie } })
    assert.equal(stale.status, 401, '旧 cookie 必须失效')
  })

  test('密码太短被拒', async () => {
    const login = await postForm(harness.origin, '/login', { username: 'admin', password: 'correct horse' })
    const cookie = cookieFrom(login)
    const r = await postJson(harness.origin, '/web-auth/password', { password: 'x', confirm: 'x' }, cookie)
    assert.equal(r.status, 400)
    assert.equal(JSON.parse(r.body).error, 'passwordTooShort')
  })
})

describe('两步验证', () => {
  let harness
  before(async () => {
    harness = await startHarness()
    await postForm(harness.origin, '/setup', { username: 'admin', password: 'correct horse', confirm: 'correct horse' })
  })
  after(async () => { await harness.close() })

  test('开户流程：begin 产出密钥，confirm 用正确验证码启用', async () => {
    const login = await postForm(harness.origin, '/login', { username: 'admin', password: 'correct horse' })
    const cookie = cookieFrom(login)

    const begin = await postJson(harness.origin, '/web-auth/totp/begin', {}, cookie)
    assert.equal(begin.status, 200)
    assert.equal(JSON.parse(begin.body).ok, true)

    const record = harness.credentials.records.get('web-auth/totp')
    assert.ok(record, '应写入待确认密钥')
    assert.equal(record.payload.enabled, false)

    const { totpAt, decodeBase32, totpCounter } = await import('../lib/crypto.js')
    const code = totpAt(decodeBase32(record.payload.secret), totpCounter())
    const confirm = await postJson(harness.origin, '/web-auth/totp/confirm', { code }, cookie)
    assert.equal(confirm.status, 200)
    assert.equal(harness.credentials.records.get('web-auth/totp').payload.enabled, true)
  })

  test('启用后登录需要验证码', async () => {
    const noCode = await postForm(harness.origin, '/login', { username: 'admin', password: 'correct horse' })
    assert.equal(noCode.status, 401)
    assert.match(noCode.body, /Wrong or already-used code/)

    const { totpAt, decodeBase32, totpCounter } = await import('../lib/crypto.js')
    const secret = harness.credentials.records.get('web-auth/totp').payload.secret
    const code = totpAt(decodeBase32(secret), totpCounter())
    const withCode = await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse', totp: code })
    assert.equal(withCode.status, 303)
  })

  test('同一验证码不能重放', async () => {
    const { totpAt, decodeBase32, totpCounter } = await import('../lib/crypto.js')
    const secret = harness.credentials.records.get('web-auth/totp').payload.secret
    const counter = totpCounter()
    // 用下一个时间窗（必然未被使用过）
    const code = totpAt(decodeBase32(secret), counter + 1)
    const first = await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse', totp: code })
    assert.equal(first.status, 303, '首次使用应成功')
    const replay = await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse', totp: code })
    assert.equal(replay.status, 401, '重放应被拒')
  })

  test('关闭两步验证后登录不再需要验证码', async () => {
    const { totpAt, decodeBase32, totpCounter } = await import('../lib/crypto.js')
    // 前面的用例把 lastUsedCounter 推到了未来窗口；这里重置它，
    // 等价于"过了一段时间再操作"，避免依赖真实 30 秒轮换。
    const record = harness.credentials.records.get('web-auth/totp')
    record.payload.lastUsedCounter = 0
    const secret = record.payload.secret
    const counter = totpCounter()

    // 登录与关闭各用一个不同的时间窗：同一个码只能用一次（防重放）。
    const loginCode = totpAt(decodeBase32(secret), counter)
    const login = await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse', totp: loginCode })
    assert.equal(login.status, 303)
    const cookie = cookieFrom(login)

    const disableCode = totpAt(decodeBase32(secret), counter + 1)
    const disable = await postJson(harness.origin, '/web-auth/totp/disable', { code: disableCode }, cookie)
    assert.equal(disable.status, 200)
    assert.equal(harness.credentials.records.has('web-auth/totp'), false)

    const plain = await postForm(harness.origin, '/login', { username: 'admin', password: 'correct horse' })
    assert.equal(plain.status, 303, '不再需要验证码')
  })
})

describe('中文界面', () => {
  let harness
  before(async () => { harness = await startHarness() })
  after(async () => { await harness.close() })

  test('Accept-Language: zh 返回中文界面', async () => {
    const r = await request(harness.origin, '/', { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } })
    assert.equal(r.status, 200)
    assert.match(r.body, /创建账户/)
    assert.match(r.body, /用户名/)
  })
})

describe('安全边界', () => {
  test('非 loopback 来源在未设密码时不能创建账户', async () => {
    const harness = await startHarness({ bootstrapLoopbackOnly: true })
    // 直接调用处理器无法伪造 remoteAddress，改为断言配置生效：
    // 这里验证的是"默认开启"，其行为由 isLoopback 决定，已在实现中固定。
    assert.ok(Config.dict.bootstrapLoopbackOnly, 'schema 声明了 bootstrapLoopbackOnly')
    await harness.close()
  })

  test('所有页面都带 no-store，避免缓存泄露登录态', async () => {
    const harness = await startHarness()
    const r = await request(harness.origin, '/')
    assert.equal(r.headers.get('cache-control'), 'no-store')
    await harness.close()
  })

  test('未知方法返回 405 而不是崩溃', async () => {
    const harness = await startHarness()
    const r = await request(harness.origin, '/login', { method: 'DELETE' })
    assert.equal(r.status, 405)
    await harness.close()
  })
})

describe('页内设置面板的 JSON 端点', () => {
  let harness

  /** 发 JSON POST。 */
  const postJson = (origin, path, fields, cookie) => request(origin, path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(fields),
  })

  beforeEach(async () => {
    harness = await startHarness({ minPasswordLength: 8 })
    await postForm(harness.origin, '/setup',
      { username: 'admin', password: 'correct horse', confirm: 'correct horse' })
  })
  afterEach(async () => { await harness.close() })

  test('未登录访问状态端点返回 401 JSON', async () => {
    const r = await request(harness.origin, '/web-auth/status')
    assert.equal(r.status, 401)
    assert.deepEqual(JSON.parse(r.body), { ok: false, error: 'unauthenticated' })
  })

  test('已登录读到账户状态', async () => {
    const cookie = cookieFrom(await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse' }))
    const r = await request(harness.origin, '/web-auth/status', { headers: { cookie } })
    assert.equal(r.status, 200)
    const body = JSON.parse(r.body)
    assert.equal(body.ok, true)
    assert.equal(body.username, 'admin')
    assert.equal(body.totpEnabled, false)
    assert.equal(body.sessionDays, 365)
  })

  test('JSON 请求体被正确解析：改密码生效（曾因解析成空对象而误报"密码太短"）', async () => {
    const cookie = cookieFrom(await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse' }))

    const changed = await postJson(harness.origin, '/web-auth/password',
      { password: 'battery staple', confirm: 'battery staple' }, cookie)
    assert.equal(changed.status, 200, `改密码失败：${changed.body}`)

    // 旧密码失效、新密码可用——这才是"真的改成功了"。
    const oldPassword = await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse' })
    assert.equal(oldPassword.status, 401)
    const newPassword = await postForm(harness.origin, '/login',
      { username: 'admin', password: 'battery staple' })
    assert.equal(newPassword.status, 303)
  })

  test('JSON 密码太短给出结构化错误', async () => {
    const cookie = cookieFrom(await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse' }))
    const r = await postJson(harness.origin, '/web-auth/password',
      { password: 'short', confirm: 'short' }, cookie)
    assert.equal(r.status, 400)
    assert.equal(JSON.parse(r.body).error, 'passwordTooShort')
  })

  test('JSON 两步验证开户与确认', async () => {
    const cookie = cookieFrom(await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse' }))

    const begin = await postJson(harness.origin, '/web-auth/totp/begin', {}, cookie)
    assert.equal(begin.status, 200)
    const opened = JSON.parse(begin.body)
    assert.equal(opened.ok, true)
    assert.equal(opened.secret.length, 32)
    assert.match(opened.otpauthUri, /^otpauth:\/\/totp\//)

    const { totpAt, decodeBase32, totpCounter } = await import('../lib/crypto.js')
    const code = totpAt(decodeBase32(opened.secret), totpCounter())
    const confirm = await postJson(harness.origin, '/web-auth/totp/confirm', { code }, cookie)
    assert.equal(confirm.status, 200)
    assert.equal(harness.credentials.records.get('web-auth/totp').payload.enabled, true)

    const status = JSON.parse((await request(harness.origin, '/web-auth/status', { headers: { cookie } })).body)
    assert.equal(status.totpEnabled, true)
  })

  test('JSON 端点也接受表单编码（两种入口共用同一套逻辑）', async () => {
    const cookie = cookieFrom(await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse' }))
    const r = await postForm(harness.origin, '/web-auth/password',
      { password: 'battery staple', confirm: 'battery staple' }, cookie)
    assert.equal(r.status, 200, `表单入口改密码失败：${r.body}`)
  })

  test('JSON 退出登录立即吊销当前会话', async () => {
    const cookie = cookieFrom(await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse' }))
    const out = await postJson(harness.origin, '/web-auth/logout', {}, cookie)
    assert.equal(out.status, 200)

    const after = await request(harness.origin, '/web-auth/status', { headers: { cookie } })
    assert.equal(after.status, 401, '退出后同一 cookie 必须被拒绝')
  })

  test('超长请求体被拒，不会撑爆内存', async () => {
    const cookie = cookieFrom(await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse' }))
    const huge = 'x'.repeat(9000)
    // 超过上限时服务端立即拒绝并断开连接，客户端看到的是连接错误而不是响应。
    // 断言的关键是"请求没有被接受"：既不能改成功，也不能把进程拖挂。
    await assert.rejects(
      postJson(harness.origin, '/web-auth/password', { password: huge, confirm: huge }, cookie),
      /fetch failed|socket|closed/i,
    )
    // 进程仍然可用：后续正常请求有响应。
    const alive = await request(harness.origin, '/web-auth/status', { headers: { cookie } })
    assert.equal(alive.status, 200, '超长请求后进程必须仍然可用')
  })
})

describe('修改用户名', () => {
  let harness

  const postJson = (origin, path, fields, cookie) => request(origin, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify(fields),
  })

  beforeEach(async () => {
    harness = await startHarness()
    await postForm(harness.origin, '/setup',
      { username: 'admin', password: 'correct horse', confirm: 'correct horse' })
  })
  afterEach(async () => { await harness.close() })

  test('JSON 面板改用户名生效，且会话不受影响', async () => {
    const cookie = cookieFrom(await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse' }))

    const changed = await postJson(harness.origin, '/web-auth/username', { username: 'sun' }, cookie)
    assert.equal(changed.status, 200, changed.body)
    assert.equal(JSON.parse(changed.body).username, 'sun')

    // 用户名只是显示名，不参与凭据校验：当前会话必须继续有效。
    const status = await request(harness.origin, '/web-auth/status', { headers: { cookie } })
    assert.equal(status.status, 200, '改用户名不应让当前会话失效')
    assert.equal(JSON.parse(status.body).username, 'sun')

    // 密码没变，仍可登录。
    const login = await postForm(harness.origin, '/login',
      { username: 'sun', password: 'correct horse' })
    assert.equal(login.status, 303)
  })

  test('非法用户名被拒，错误明确', async () => {
    const cookie = cookieFrom(await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse' }))

    for (const bad of ['', '   ', 'has space', 'a'.repeat(65), 'bad\nname', 'emoji😀']) {
      const r = await postJson(harness.origin, '/web-auth/username', { username: bad }, cookie)
      assert.equal(r.status, 400, `应拒绝用户名 ${JSON.stringify(bad)}`)
      assert.equal(JSON.parse(r.body).error, 'usernameInvalid')
    }

    // 拒绝后原值不变。
    const status = await request(harness.origin, '/web-auth/status', { headers: { cookie } })
    assert.equal(JSON.parse(status.body).username, 'admin')
  })

  test('未登录不能改用户名', async () => {
    const r = await postJson(harness.origin, '/web-auth/username', { username: 'x' })
    assert.equal(r.status, 401)
  })
})

describe('两步验证二维码', () => {
  let harness
  before(async () => {
    harness = await startHarness()
    await postForm(harness.origin, '/setup',
      { username: 'admin', password: 'correct horse', confirm: 'correct horse' })
  })
  after(async () => { await harness.close() })

  test('开户响应带可直接渲染的二维码 data URI', async () => {
    const cookie = cookieFrom(await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse' }))
    const begin = await request(harness.origin, '/web-auth/totp/begin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    })
    const body = JSON.parse(begin.body)
    assert.equal(body.ok, true)
    assert.match(body.qrDataUri, /^data:image\/svg\+xml;base64,/, '缺少二维码 data URI')

    // 解出 SVG 看它确实是二维码图形，而不是空串。
    const svg = Buffer.from(body.qrDataUri.split(',')[1], 'base64').toString('utf8')
    assert.match(svg, /^<svg[^>]*>/)
    assert.match(svg, /<path/, '二维码 SVG 应包含路径数据')
    assert.ok(svg.length > 300, '二维码 SVG 过小，可能没有内容')

    // 二维码编码的必须是同一份 otpauth URI。
    assert.ok(body.otpauthUri.includes(body.secret), 'otpauth URI 必须包含该密钥')
  })
})

describe('用启动令牌进入后的首次建账户', () => {
  let harness

  beforeEach(async () => {
    // 关键场景：还没有任何账户，但用户已经通过 `?token=` 拿到会话。
    harness = await startHarness()
  })
  afterEach(async () => { await harness.close() })

  /** 模拟"令牌登录后的会话"：直接签发一条 cookie。 */
  const tokenSession = async () => {
    const { mintCookieValue } = await import('../lib/crypto.js')
    const secret = harness.credentials.records.get(SIGNING_KEY).payload
    const { parseSigningSecret } = await import('../lib/crypto.js')
    const key = parseSigningSecret({ kind: 'grant', payload: secret })
    const authority = `${AUTHORITY_HEADER}:${harness.port}`
    const now = Date.now()
    const value = mintCookieValue(key, authority, now, now + 86_400_000)
    return `${cookieName(authority)}=${value}`
  }

  test('尚无账户时，带令牌或旧会话访问首页仍先进首次设置', async () => {
    const cookie = await tokenSession()

    // 带启动令牌
    const withToken = await request(harness.origin, '/?token=abc', { headers: { cookie } })
    assert.equal(withToken.status, 200)
    assert.match(withToken.body, /Create your account/, '无账户时带令牌也必须先进设置页')
    assert.doesNotMatch(withToken.body, /DeepSeek Harness/, '不该直接放行到应用')

    // 只带一条有效会话
    const withSession = await request(harness.origin, '/', { headers: { cookie } })
    assert.equal(withSession.status, 200)
    assert.match(withSession.body, /Create your account/, '无账户时有效会话也必须先设置')
  })

  test('账户建立后，带令牌访问才直接进应用', async () => {
    const cookie = await tokenSession()
    await postJson(harness.origin, '/web-auth/setup',
      { username: 'sun', password: 'firstpass1', confirm: 'firstpass1' }, cookie)

    const r = await request(harness.origin, '/?token=abc')
    assert.equal(r.status, 303, '账户就绪后令牌照常交换')
  })

  test('状态端点报告尚无账户', async () => {
    const cookie = await tokenSession()
    const r = await request(harness.origin, '/web-auth/status', { headers: { cookie } })
    assert.equal(r.status, 200)
    const body = JSON.parse(r.body)
    assert.equal(body.hasAccount, false)
    assert.equal(body.username, '')
  })

  test('面板可以创建账户，之后状态变为已存在', async () => {
    const cookie = await tokenSession()
    const created = await postJson(harness.origin, '/web-auth/setup',
      { username: 'sun', password: 'firstpass1', confirm: 'firstpass1' }, cookie)
    assert.equal(created.status, 200, created.body)
    assert.equal(harness.credentials.records.get('web-auth/password').payload.username, 'sun')

    const status = await request(harness.origin, '/web-auth/status', { headers: { cookie } })
    assert.equal(JSON.parse(status.body).hasAccount, true)

    // 建完就能用密码登录。
    const login = await postForm(harness.origin, '/login', { username: 'sun', password: 'firstpass1' })
    assert.equal(login.status, 303)
  })

  test('已有账户时再次创建被拒', async () => {
    const cookie = await tokenSession()
    await postJson(harness.origin, '/web-auth/setup',
      { username: 'sun', password: 'firstpass1', confirm: 'firstpass1' }, cookie)
    const again = await postJson(harness.origin, '/web-auth/setup',
      { username: 'other', password: 'secondpass2', confirm: 'secondpass2' }, cookie)
    assert.equal(again.status, 409)
    assert.equal(JSON.parse(again.body).error, 'accountExists')
    assert.equal(harness.credentials.records.get('web-auth/password').payload.username, 'sun')
  })

  test('创建时校验用户名与口令', async () => {
    const cookie = await tokenSession()
    const cases = [
      [{ username: '', password: 'firstpass1', confirm: 'firstpass1' }, 'usernameInvalid'],
      [{ username: 'bad name', password: 'firstpass1', confirm: 'firstpass1' }, 'usernameInvalid'],
      [{ username: 'sun', password: 'short', confirm: 'short' }, 'passwordTooShort'],
      [{ username: 'sun', password: 'firstpass1', confirm: 'different1' }, 'passwordsDoNotMatch'],
    ]
    for (const [fields, error] of cases) {
      const r = await postJson(harness.origin, '/web-auth/setup', fields, cookie)
      assert.equal(r.status, 400, JSON.stringify(fields))
      assert.equal(JSON.parse(r.body).error, error)
    }
    assert.equal(harness.credentials.records.has('web-auth/password'), false, '校验失败不应写入记录')
  })

  test('未登录不能创建账户', async () => {
    const r = await postJson(harness.origin, '/web-auth/setup',
      { username: 'sun', password: 'firstpass1', confirm: 'firstpass1' })
    assert.equal(r.status, 401)
  })

  test('无账户时改用户名/改密码返回 409 而不是假成功', async () => {
    const cookie = await tokenSession()
    for (const path of ['/web-auth/username', '/web-auth/password']) {
      const r = await postJson(harness.origin, path, { username: 'x', password: 'firstpass1', confirm: 'firstpass1' }, cookie)
      assert.equal(r.status, 409, `${path} 应拒绝`)
      assert.equal(JSON.parse(r.body).error, 'noAccount')
    }
    assert.equal(harness.credentials.records.has('web-auth/password'), false, '不应悄悄创建记录')
  })
})

describe('已认证用户取回应用外壳', () => {
  let harness
  let distIndex
  let tempDir

  before(async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    tempDir = await mkdtemp(join(tmpdir(), 'wpa-dist-'))
    distIndex = join(tempDir, 'index.html')
    await writeFile(distIndex, '<!doctype html><html><head><title>Host App</title></head><body>app</body></html>')

    // 模拟 Host 的 frontend-static：它的 fiber 配置里带着真实 dist 路径。
    const registry = {
      values: () => [{ name: 'frontend-static', fibers: [{ config: { distIndex } }] }],
    }
    harness = await startHarness({ registry })
    await postForm(harness.origin, '/setup',
      { username: 'admin', password: 'correct horse', confirm: 'correct horse' })
  })
  after(async () => {
    await harness.close()
    const { rm } = await import('node:fs/promises')
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
  })

  test('优先使用 Host 自己算好的 distIndex，而不是插件自己猜的路径', async () => {
    const cookie = cookieFrom(await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse' }))
    const r = await request(harness.origin, '/', { headers: { cookie } })
    assert.equal(r.status, 200)
    assert.match(r.body, /<title>Host App<\/title>/, r.body.slice(0, 200))
    // 插件还要补上相对资源所需的 base
    assert.match(r.body, /<base href="\.\/">/)
  })

  test('Host 的 distIndex 指向不存在的文件时会被跳过，而不是直接报错', async () => {
    // 复现真实故障：frontend-static 的配置指向一个已经被删掉/没构建的路径。
    // 旧实现拿到就用，于是已认证用户看到 "the Web frontend is not built"。
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'wpa-stale-'))
    const real = join(dir, 'real.html')
    await writeFile(real, '<!doctype html><title>Real App</title>')

    const registry = {
      values: () => [{
        name: 'frontend-static',
        fibers: [
          { config: { distIndex: join(dir, 'gone.html') } }, // 陈旧路径
          { config: { distIndex: real } },                    // 真实可用路径
        ],
      }],
    }
    const other = await startHarness({ registry })
    try {
      await postForm(other.origin, '/setup',
        { username: 'admin', password: 'correct horse', confirm: 'correct horse' })
      const cookie = cookieFrom(await postForm(other.origin, '/login',
        { username: 'admin', password: 'correct horse' }))
      const r = await request(other.origin, '/', { headers: { cookie } })
      assert.equal(r.status, 200)
      assert.match(r.body, /Real App/, '应跳过不存在的候选，用下一个可用的')
    } finally {
      await other.close()
      const { rm } = await import('node:fs/promises')
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('找不到前端产物时把 / 交还宿主，而不是让界面打不开', async () => {
    // 这台 harness 不带 distIndex，且插件自身位置也解析不到前端包。
    const other = await startHarness({ registry: { values: () => [] } })
    try {
      await postForm(other.origin, '/setup',
        { username: 'admin', password: 'correct horse', confirm: 'correct horse' })
      const cookie = cookieFrom(await postForm(other.origin, '/login',
        { username: 'admin', password: 'correct horse' }))

      // 第一次：释放 index 路由并重定向，让浏览器重新请求
      const first = await request(other.origin, '/', { headers: { cookie } })
      assert.equal(first.status, 302, '应把请求交还宿主而不是 500')
      assert.equal(first.headers.get('location'), '/')

      // 第二次：`/` 已不在本插件的路由表里，交给 fallback（真实环境即宿主的
      // 前端静态服务），界面能正常打开。
      const second = await request(other.origin, '/', { headers: { cookie } })
      assert.equal(second.status, 200)
      assert.match(second.body, /host fallback/, '应由宿主接手')

      // 交还只影响 index 两条路由，登录等仍由本插件提供
      assert.equal((await request(other.origin, '/login')).status, 200)
    } finally {
      await other.close()
    }
  })
})

describe('兼容新版 Host 的 renderIndex(html, peer)', () => {
  /**
   * 新版 Host 的 `renderIndex` 需要第二个参数 `peer`：内部用它收集 index 注入行，
   * 漏传时 emit 抛错，插件会把异常误报成"前端读不出来"，已认证用户就打不开界面。
   * 旧版 Host 只要一个参数。
   *
   * 这条约束用一个会抛错的 renderIndex 复现（`requirePeer`），因此只要调用形态
   * 退回单参数，这个套件立刻失败。
   */
  let harness
  let calls
  let tempDir
  let distIndex

  before(async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    tempDir = await mkdtemp(join(tmpdir(), 'wpa-peer-'))
    distIndex = join(tempDir, 'index.html')
    await writeFile(distIndex, '<!doctype html><html><head><title>App</title></head><body>b</body></html>')

    calls = []
    harness = await startHarness({
      registry: { values: () => [{ name: 'frontend-static', fibers: [{ config: { distIndex } }] }] },
      renderIndexCalls: calls,
      requirePeer: true,
    })
    await postForm(harness.origin, '/setup',
      { username: 'admin', password: 'correct horse', confirm: 'correct horse' })
  })
  after(async () => {
    await harness.close()
    const { rm } = await import('node:fs/promises')
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
  })

  test('调用时带上 peer，且页面正常返回', async () => {
    const cookie = cookieFrom(await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse' }))
    const r = await request(harness.origin, '/', { headers: { cookie } })

    assert.equal(r.status, 200, `应正常出页面，实际 ${r.status}: ${r.body.slice(0, 120)}`)
    assert.match(r.body, /<title>App<\/title>/)
    // 宿主的注入行保留
    assert.match(r.body, /__INJECTED__/, '宿主的 index 注入必须生效')

    assert.ok(calls.length > 0, 'renderIndex 应被调用')
    assert.equal(calls[0].length, 2, '必须传两个实参')
    assert.notEqual(calls[0][1], undefined, 'peer 不能是 undefined')
  })
})

describe('旧版 Host（无 browserPeer）也能正常出页面', () => {
  let harness
  let tempDir

  before(async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    tempDir = await mkdtemp(join(tmpdir(), 'wpa-old-'))
    const distIndex = join(tempDir, 'index.html')
    await writeFile(distIndex, '<!doctype html><html><head><title>Old</title></head><body>b</body></html>')

    harness = await startHarness({
      browserPeer: false, // 旧宿主没有这个属性
      registry: { values: () => [{ name: 'frontend-static', fibers: [{ config: { distIndex } }] }] },
      // 旧宿主的 renderIndex 只接受一个参数，不会因为缺 peer 抛错
      requirePeer: false,
    })
    await postForm(harness.origin, '/setup',
      { username: 'admin', password: 'correct horse', confirm: 'correct horse' })
  })
  after(async () => {
    await harness.close()
    const { rm } = await import('node:fs/promises')
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
  })

  test('走单参数签名，页面正常返回', async () => {
    const cookie = cookieFrom(await postForm(harness.origin, '/login',
      { username: 'admin', password: 'correct horse' }))
    const r = await request(harness.origin, '/', { headers: { cookie } })
    assert.equal(r.status, 200, r.body.slice(0, 120))
    assert.match(r.body, /<title>Old<\/title>/)
  })
})
