/**
 * pages.js —— 登录页、首次引导页、账户页的 HTML。
 *
 * ## 为什么是服务端渲染的独立 HTML，而不是 SPA 的一部分
 *
 * 未认证时 `frontend-static` 只返回一段纯文本 401，**连 index.html 的字节都不发**
 * （frontend-static/src/index.ts:89 直接 return）。所以 SPA 根本没启动，登录页
 * 只能在 Host 侧产出。
 *
 * ## 为什么自带配色而不复用 --dsw-* 变量
 *
 * 那些变量由 `ui-theme` 的 client bundle 注入，而未登录的页面拿不到 client
 * bundle。所以这里用一组与 DSH 深/浅色主题近似的中性色，并通过
 * `prefers-color-scheme` 跟随系统。
 *
 * 所有用户可见文案都在 {@link STRINGS} 里，中英各一份，由请求的 locale 选择。
 */

/** 页面文案。新增文案时必须同时补齐两种语言。 */
export const STRINGS = {
  en: {
    loginTitle: 'Sign in',
    loginSubtitle: 'This DeepSeek Harness requires a password.',
    setupTitle: 'Create your account',
    setupSubtitle: 'This is the first run. Set the username and password for this harness.',
    username: 'Username',
    password: 'Password',
    newPassword: 'New password',
    confirmPassword: 'Confirm password',
    totpCode: '6-digit code',
    totpCodeHint: 'From your authenticator app',
    signIn: 'Sign in',
    createAccount: 'Create account',
    usernameInvalid: 'Use 1-64 letters, digits, dots, dashes or underscores.',
    passwordsDoNotMatch: 'The two passwords do not match.',
    passwordTooShort: 'Use at least 8 characters.',
    wrongCredentials: 'Wrong username or password.',
    wrongTotp: 'Wrong or already-used code.',
    passwordChanged: 'Password changed. Every session was signed out; sign in again.',
    lockedOut: 'Too many attempts. Try again in {minutes} minute(s).',
    offlineNote: 'Local fallback: the URL printed by "dsh web" also signs you in.',
    needTotpSetup: 'Two-factor authentication is enabled. Enter the code from your authenticator.',
    bootstrapWarning: 'Anyone who can reach this page before you set a password becomes the owner. Set it now.',
  },
  zh: {
    loginTitle: '登录',
    loginSubtitle: '此 DeepSeek Harness 需要密码。',
    setupTitle: '创建账户',
    setupSubtitle: '首次运行。请为这个 Harness 设置用户名与密码。',
    username: '用户名',
    password: '密码',
    newPassword: '新密码',
    confirmPassword: '确认新密码',
    totpCode: '6 位验证码',
    totpCodeHint: '来自你的验证器 App',
    signIn: '登录',
    createAccount: '创建账户',
    usernameInvalid: '请使用 1-64 位字母、数字、点、短横线或下划线。',
    passwordsDoNotMatch: '两次输入的密码不一致。',
    passwordTooShort: '至少 8 个字符。',
    wrongCredentials: '用户名或密码错误。',
    wrongTotp: '验证码错误或已使用。',
    passwordChanged: '密码已修改，所有会话已退出，请重新登录。',
    lockedOut: '尝试次数过多，请 {minutes} 分钟后再试。',
    offlineNote: '本地兜底：「dsh web」打印的网址也能直接进入。',
    needTotpSetup: '已开启两步验证，请输入验证器中的验证码。',
    bootstrapWarning: '在你设置密码之前，任何能访问此页面的人都会成为主人。请立即设置。',
  },
}

/** 取文案表；未知语言回退英文。 */
export function stringsFor(locale) {
  return String(locale ?? '').toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en
}

/** HTML 转义，覆盖文本与属性两种上下文。 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 内联样式表。
 * 用 `:root` 的两套变量 + `prefers-color-scheme` 跟随系统，深色为默认
 * （与 DSH Web 的默认外观一致：`<style>:root{color-scheme:dark}</style>`）。
 */
const STYLE = `
/*
 * 这套页面的配色直接取自产品自己的设计变量（--dsw-alias-*）的实际值。
 *
 * 不能直接写 var(--dsw-...) ：未认证时客户端的样式表还没加载，变量不存在。
 * 但也不能自创一套——曾经用过蓝色主按钮，而产品的主按钮是近黑色，用户从登录页
 * 进入应用时会看到主按钮换了个颜色。所以这里是"抄值"，不是"另创"。
 */
:root{
  color-scheme:dark;
  /* 以下取值对应产品暗色：bg-base / bg-layer-2 / bg-layer-3 / label-primary /
     label-secondary / border-l4 / brand-primary / state-error */
  --bg:#151517;--panel:#2c2c2e;--panel-2:#353638;
  --text:#f9fafb;--muted:#cfd3d6;--border:#ffffff33;
  --accent:#f9fafb;--accent-text:#0f1115;--danger:#f25a5a;--ok:#22c55e;
  --ring:#f9fafb;
}
@media (prefers-color-scheme:light){
  :root{
    color-scheme:light;
    --bg:#f7f7f8;--panel:#fff;--panel-2:#f5f6f7;
    --text:#0f1115;--muted:#61666b;--border:#00000029;
    --accent:#0f1115;--accent-text:#fff;--danger:#ec1313;--ok:#22c55e;
    --ring:#0f1115;
  }
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;background:var(--bg);color:var(--text);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
  display:flex;align-items:center;justify-content:center;padding:24px;
}
.card{
  width:100%;max-width:420px;background:var(--panel);
  border:1px solid var(--border);border-radius:12px;padding:28px;
}
.card.wide{max-width:520px}
h1{margin:0 0 6px;font-size:20px;font-weight:500;letter-spacing:-0.01em}
.sub{margin:0 0 20px;color:var(--muted);font-size:13px}
label{display:block;margin:14px 0 6px;font-size:13px;color:var(--muted)}
input[type=text],input[type=password],input[type=tel]{
  width:100%;height:36px;padding:0 12px;border-radius:8px;font-size:14px;
  background:var(--panel-2);color:var(--text);border:1px solid var(--border);
  font-family:inherit;
}
/* 键盘可见的焦点环。只改边框色对键盘用户不够——登录页是所有人必经的页面。 */
input:focus{outline:none;border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in srgb,var(--ring) 20%,transparent)}
button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
button{
  margin-top:20px;width:100%;height:36px;padding:0 14px;border-radius:8px;border:1px solid transparent;
  background:var(--accent);color:var(--accent-text);font-size:14px;font-weight:500;
  font-family:inherit;cursor:pointer;
}
button:hover:not(:disabled){opacity:.88}
button:disabled{opacity:.45;cursor:default}
button.secondary{background:var(--panel-2);color:var(--text);border-color:var(--border)}
button.danger{background:transparent;color:var(--danger);border-color:var(--danger)}
.row{display:flex;gap:10px}
.row>button{margin-top:0}
.msg{margin:16px 0 0;padding:10px 12px;border-radius:8px;font-size:13px}
.msg.error{background:color-mix(in srgb,var(--danger) 14%,transparent);color:var(--danger)}
.msg.ok{background:color-mix(in srgb,var(--ok) 14%,transparent);color:var(--ok)}
.msg.note{background:var(--panel-2);color:var(--muted)}
.hint{margin:8px 0 0;font-size:12.5px;color:var(--muted)}
/* 二维码不得超出内容列：480px 视口下内容列只有约 196px，固定 236px 会撑出横向滚动。 */
.qr{display:block;margin:10px 0 14px;border-radius:8px;background:#fff;padding:8px;
    width:236px;max-width:100%;height:auto}
.secret{
  display:block;margin:10px 0 0;padding:12px;border-radius:8px;background:var(--panel-2);
  border:1px solid var(--border);font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
  word-break:break-all;user-select:all;
}
.divider{height:1px;background:var(--border);margin:24px 0}
.status{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);flex:none}
.dot.off{background:var(--muted)}
a{color:var(--text)}
/* iOS 在小于 16px 的输入框上聚焦会强制缩放页面 */
@media (max-width:480px){
  input[type=text],input[type=password],input[type=tel]{font-size:16px}
}
`

/**
 * 渲染一个完整 HTML 文档。
 * @param {object} options - 页面内容。
 * @param {object} options.t - 文案表。
 * @param {string} options.title - 文档标题。
 * @param {string} options.body - 已转义安全的 body 内 HTML。
 * @param {boolean} [options.wide] - 使用更宽的卡片。
 * @returns {string} HTML 文档。
 */
function document({ t, title, body, wide = false }) {
  return `<!doctype html>
<html lang="${t === STRINGS.zh ? 'zh' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="card${wide ? ' wide' : ''}">
${body}
</div>
</body>
</html>`
}

/** 渲染错误/提示块；无消息时不输出任何东西。 */
function message(t, kind, code, params) {
  if (!code) return ''
  const text = t[code] ?? code
  const rendered = params ? text.replace(/\{(\w+)\}/g, (_, key) => escapeHtml(params[key] ?? '')) : text
  // 失败信息必须能被读屏软件播报：页面是整页刷新，焦点不会自动落到这里。
  const role = kind === 'error' ? ' role="alert"' : ''
  return `<p class="msg ${kind}"${role}>${rendered}</p>`
}

/**
 * 登录页。
 * @param {object} options - 页面状态。
 * @param {object} options.t - 文案表。
 * @param {string} [options.error] - 错误文案 key。
 * @param {string} [options.errorParams] - 文案占位符。
 * @param {boolean} [options.needsTotp] - 是否显示验证码输入框。
 * @param {string} [options.username] - 预填用户名。
 * @param {string} [options.notice] - 中性提示 key。
 * @returns {string} HTML。
 */
export function renderLoginPage({ t, error, errorParams, needsTotp = false, username = '', notice }) {
  const body = `
<h1>${escapeHtml(t.loginTitle)}</h1>
<p class="sub">${escapeHtml(needsTotp ? t.needTotpSetup : t.loginSubtitle)}</p>
${message(t, 'error', error, errorParams)}
${message(t, 'note', notice)}
<form method="POST" action="login" autocomplete="on">
  <label for="u">${escapeHtml(t.username)}</label>
  <input id="u" name="username" type="text" value="${escapeHtml(username)}" autocomplete="username" required${error ? '' : ' autofocus'}>
  <label for="p">${escapeHtml(t.password)}</label>
  <input id="p" name="password" type="password" autocomplete="current-password" required${error ? ' autofocus' : ''}>
  ${needsTotp ? `
  <label for="c">${escapeHtml(t.totpCode)}</label>
  <input id="c" name="totp" type="tel" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
         autocomplete="one-time-code" placeholder="000000" required>
  <p class="hint">${escapeHtml(t.totpCodeHint)}</p>` : ''}
  <button type="submit">${escapeHtml(t.signIn)}</button>
</form>
<p class="hint">${escapeHtml(t.offlineNote)}</p>`
  return document({ t, title: t.loginTitle, body })
}

/**
 * 首次引导页：创建账户。
 * @param {object} options - 页面状态。
 * @param {object} options.t - 文案表。
 * @param {string} [options.error] - 错误 key。
 * @returns {string} HTML。
 */
export function renderSetupPage({ t, error }) {
  const body = `
<h1>${escapeHtml(t.setupTitle)}</h1>
<p class="sub">${escapeHtml(t.setupSubtitle)}</p>
${message(t, 'note', 'bootstrapWarning')}
${message(t, 'error', error)}
<form method="POST" action="setup" autocomplete="on">
  <label for="u">${escapeHtml(t.username)}</label>
  <input id="u" name="username" type="text" autocomplete="username" required autofocus>
  <label for="p">${escapeHtml(t.newPassword)}</label>
  <input id="p" name="password" type="password" autocomplete="new-password" minlength="8" required>
  <label for="p2">${escapeHtml(t.confirmPassword)}</label>
  <input id="p2" name="confirm" type="password" autocomplete="new-password" minlength="8" required>
  <button type="submit">${escapeHtml(t.createAccount)}</button>
</form>`
  return document({ t, title: t.setupTitle, body })
}

/**
 * 极简错误页，用于不该发生但必须给出可读反馈的分支。
 * @param {object} options - 内容。
 * @param {object} options.t - 文案表。
 * @param {number} options.status - HTTP 状态码。
 * @param {string} options.message - 已本地化的说明文本（会被转义）。
 * @returns {string} HTML。
 */
export function renderErrorPage({ t, status, message: text }) {
  const body = `
<h1>${escapeHtml(String(status))}</h1>
<p class="sub">${escapeHtml(text)}</p>
<form method="GET" action="login"><button class="secondary" type="submit">${escapeHtml(t.signIn)}</button></form>`
  return document({ t, title: String(status), body })
}
