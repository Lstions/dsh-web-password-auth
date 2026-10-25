/**
 * client.test.mjs —— 浏览器半边的渲染测试。
 *
 * 这一层就是之前缺的那一环：bundle 能加载、slot 注册成功，并不代表界面能显示。
 * 文案键写错、分支抛异常，只会在界面上留下一块空白。所以这里**真的把组件渲染
 * 成 HTML**，对每个状态断言看得见的内容。
 *
 * react / react-dom 是 devDependency：渲染测试需要真实的 React 行为，而不是桩。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

import react from 'react'
import ReactDOMServer from 'react-dom/server'

/**
 * 在模拟的浏览器环境里执行 client bundle，取回它的模块导出。
 * @returns {object} 插件导出的成员。
 */
function loadClientModule() {
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const loaders = []
  const styles = []
  const sandbox = {
    window: { __ModuleLoader__: { load: entry => loaders.push(entry) } },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: '' }),
      head: { appendChild: element => styles.push(element) },
    },
    fetch: async () => ({ status: 200, json: async () => ({ ok: true }) }),
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  assert.equal(loaders.length, 1, 'client bundle 应注册恰好一个 loader 条目')
  const exported = loaders[0].factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  })
  exported.__styles = styles
  return exported
}

const clientModule = loadClientModule()

/** 中文翻译器（模拟框架注入的 t）。 */
const tr = clientModule.translator(clientModule.ZH)

/** 渲染成 HTML 字符串。 */
function render(element) {
  return ReactDOMServer.renderToStaticMarkup(element)
}

/** 渲染 SecurityView 的便捷包装。 */
function renderView(overrides = {}) {
  const base = {
    tr,
    phase: 'ready',
    status: { ok: true, username: 'admin', totpEnabled: false, totpAvailable: true, sessionDays: 365, minPasswordLength: 8 },
    busy: false,
    form: { username: 'admin', password: '', confirm: '', code: '' },
    actions: new Proxy({}, { get: () => () => {} }),
  }
  return render(react.createElement(clientModule.SecurityView, { ...base, ...overrides }))
}

test('模块导出与注册面', () => {
  // vm 里的数组属于另一个 realm，展开后再比较，避免原型不同导致误报。
  assert.deepEqual([...clientModule.inject], ['slots', 'locale'])
  assert.equal(typeof clientModule.apply, 'function')
  assert.equal(typeof clientModule.SecuritySection, 'function')
  assert.equal(typeof clientModule.SecurityView, 'function')
  assert.ok(clientModule.__styles.length === 1, '样式应注入一次')
})

test('load 的 id 等于插件包名', () => {
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(code, /id:\s*'dsh-web-password-auth'/)
})

test('apply 注册字典并占用 settings.section', () => {
  const registered = []
  const dictionaries = []
  const ctx = {
    effect: fn => fn(),
    locale: {
      register: (ns, dict) => dictionaries.push([ns, dict]),
      bind: () => key => key,
    },
    slots: {
      inject: (name, factory) => factory(),
      register: (options, component) => { registered.push({ options, component }); return () => {} },
    },
  }
  clientModule.apply(ctx)
  assert.equal(dictionaries.length, 1, '应注册字典')
  assert.equal(dictionaries[0][0], 'web-password-auth')
  assert.ok('zh' in dictionaries[0][1] && 'en' in dictionaries[0][1], '中英双语都要有')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'settings.section')
  assert.equal(registered[0].options.id, 'web-password-auth')
  assert.equal(registered[0].options.locale, 'web-password-auth')
  assert.equal(typeof registered[0].options.label(), 'string', '导航文案必须是字符串')
})

test('就绪态渲染出全部区块（这一节之前是空白）', () => {
  const html = renderView()
  // 四个区块标题
  for (const text of ['登录与安全', '账户', '修改密码', '两步验证', '退出登录']) {
    assert.ok(html.includes(text), `缺少区块：${text}`)
  }
  // 关键控件
  assert.ok(html.includes('id="wpa-pw"'), '缺少新密码输入框')
  assert.ok(html.includes('id="wpa-pw2"'), '缺少确认密码输入框')
  assert.ok(html.includes('type="password"'), '密码框必须是 password 类型')
  assert.ok(html.includes('>保存<'), '缺少保存按钮')
  assert.ok(html.includes('>退出登录<'), '缺少退出按钮')
  // 状态文案
  assert.ok(html.includes('admin'), '应显示当前用户名')
  assert.ok(html.includes('365'), '应显示会话天数')
})

test('就绪态的输出里不出现 undefined / NaN', () => {
  const html = renderView()
  assert.ok(!html.includes('undefined'), '渲染结果里出现了 undefined')
  assert.ok(!html.includes('NaN'), '渲染结果里出现了 NaN')
})

test('两步验证关闭时显示「开启」按钮', () => {
  const html = renderView({ status: { ok: true, username: 'admin', totpEnabled: false, totpAvailable: true, sessionDays: 365 } })
  assert.ok(html.includes('两步验证已关闭'))
  assert.ok(html.includes('>开启<'))
  assert.ok(!html.includes('>关闭<'), '未开启时不该出现关闭按钮')
})

test('两步验证开启时显示验证码输入与「关闭」按钮', () => {
  const html = renderView({ status: { ok: true, username: 'admin', totpEnabled: true, totpAvailable: true, sessionDays: 365 } })
  assert.ok(html.includes('两步验证已开启'))
  assert.ok(html.includes('id="wpa-code-off"'), '缺少验证码输入框')
  assert.ok(html.includes('>关闭<'))
})

test('开户流程中显示二维码、密钥与 otpauth URI', () => {
  const html = renderView({
    pending: {
      secret: 'ABCDEFGHIJKLMNOP',
      uri: 'otpauth://totp/DSH%3Aadmin?secret=ABCDEFGHIJKLMNOP',
      qrDataUri: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    },
  })
  assert.ok(html.includes('data:image/svg+xml;base64,'), '缺少二维码图片')
  assert.ok(html.includes('class="wpa_qr"'), '二维码缺少样式类')
  assert.ok(html.includes('ABCDEFGHIJKLMNOP'), '缺少密钥')
  assert.ok(html.includes('otpauth://totp/'), '缺少 otpauth URI')
  assert.ok(html.includes('id="wpa-code-on"'), '缺少确认验证码输入框')
  assert.ok(html.includes('>确认<'))
  assert.ok(html.includes('>取消<'))
})

test('没有二维码数据时不会渲染空 img', () => {
  const html = renderView({ pending: { secret: 'ABCDEFGHIJKLMNOP', uri: 'otpauth://totp/x' } })
  assert.ok(!html.includes('wpa_qr'), '无数据时不该出现二维码元素')
  assert.ok(html.includes('ABCDEFGHIJKLMNOP'), '密钥仍然要显示，手输可用')
})

test('尚无账户时只显示创建表单，不显示改密/两步验证', () => {
  const html = renderView({ status: { ok: true, hasAccount: false, username: '', totpEnabled: false, sessionDays: 365 } })
  assert.ok(html.includes('创建密码账户'), '缺少创建账户标题')
  assert.ok(html.includes('id="wpa-new-user"'), '缺少用户名输入')
  assert.ok(html.includes('id="wpa-new-pw"'), '缺少密码输入')
  assert.ok(html.includes('id="wpa-new-pw2"'), '缺少确认密码输入')
  assert.ok(html.includes('>创建账户<'), '缺少创建按钮')
  // 没有账户时这些区块毫无意义，出现反而会误导
  assert.ok(!html.includes('wpa-user'), '不该出现改名输入')
  assert.ok(!html.includes('两步验证'), '不该出现两步验证区块')
  assert.ok(!html.includes('>退出登录<'), '不该出现退出区块')
})

test('已有账户时不显示创建表单', () => {
  const html = renderView()
  assert.ok(!html.includes('wpa-new-pw'), '已有账户不该出现创建表单')
  assert.ok(html.includes('id="wpa-user"'), '应显示常规账户区块')
})

test('账户区块可以改用户名', () => {
  const html = renderView()
  assert.ok(html.includes('id="wpa-user"'), '缺少用户名输入框')
  assert.ok(html.includes('>保存用户名<'), '缺少保存用户名按钮')
  // 当前值与服务端一致时按钮禁用，避免无意义提交
  assert.match(html, /id="wpa-user"[^>]*value="admin"/, '用户名输入框应带当前值')
})

test('加载态与失败态都有可见文案', () => {
  assert.ok(renderView({ phase: 'loading' }).includes('读取中'))
  const failed = renderView({ phase: 'failed' })
  assert.ok(failed.includes('读取状态失败'))
  assert.ok(failed.includes('>重试<'))
})

test('错误与成功提示可见', () => {
  const withError = renderView({ error: '两次输入的密码不一致。' })
  assert.ok(withError.includes('两次输入的密码不一致'))
  const withNotice = renderView({ notice: '两步验证已开启。' })
  assert.ok(withNotice.includes('两步验证已开启'))
})

test('busy 时按钮禁用，避免重复提交', () => {
  const html = renderView({ busy: true, form: { password: 'abcdefgh', confirm: 'abcdefgh', code: '123456' } })
  assert.ok(!/class="wpa_button[^"]*"[^>]*onclick/.test(html))
  assert.ok(html.includes('disabled'), 'busy 时应有禁用属性')
})

test('英文界面', () => {
  const html = render(
    react.createElement(clientModule.SecurityView, {
      tr: clientModule.translator(clientModule.EN),
      phase: 'ready',
      status: { username: 'admin', totpEnabled: false, totpAvailable: true, sessionDays: 365, minPasswordLength: 8 },
      busy: false,
      form: { password: '', confirm: '', code: '' },
      actions: new Proxy({}, { get: () => () => {} }),
    }),
  )
  for (const text of ['Sign-in and security', 'Account', 'Change password', 'Two-factor authentication', 'Sign out']) {
    assert.ok(html.includes(text), `缺少英文区块：${text}`)
  }
})

test('translator 对函数型 t、字典对象、缺失都安全', () => {
  const fromFunction = clientModule.translator((key, params) => (
    params === undefined ? `<${key}>` : `<${key}:${JSON.stringify(params)}>`))
  assert.equal(fromFunction('nav'), '<nav>')
  assert.equal(fromFunction('signedInAs', { username: 'a' }), '<signedInAs:{"username":"a"}>')

  const fromObject = clientModule.translator({ nav: '安全' })
  assert.equal(fromObject('nav'), '安全')
  assert.equal(fromObject('missing'), 'missing', '缺失键回退成键名')

  // 关键回归：属性式访问曾经让整页空白
  const fromUndefined = clientModule.translator(undefined)
  assert.equal(fromUndefined('nav'), 'nav')
  assert.equal(typeof fromUndefined('nav'), 'string')
})

test('占位符按参数替换，缺参时保留原样', () => {
  assert.equal(tr('signedInAs', { username: 'admin' }), '当前登录：admin')
  assert.equal(tr('sessionNote', { days: 30 }), '会话有效期 30 天，之后需要重新登录。')
  assert.ok(tr('passwordTooShort', { min: 8 }).includes('8'))
})

test('中英字典键集完全一致', () => {
  const zh = Object.keys(clientModule.ZH).sort()
  const en = Object.keys(clientModule.EN).sort()
  assert.deepEqual(zh, en, '中英字典的键必须一一对应')
})

test('字典里没有空值', () => {
  for (const [key, value] of Object.entries(clientModule.ZH)) {
    assert.equal(typeof value, 'string', `ZH.${key} 不是字符串`)
    assert.ok(value.length > 0, `ZH.${key} 为空`)
  }
  for (const [key, value] of Object.entries(clientModule.EN)) {
    assert.equal(typeof value, 'string', `EN.${key} 不是字符串`)
    assert.ok(value.length > 0, `EN.${key} 为空`)
  }
})
