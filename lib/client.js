/**
 * dsh-web-password-auth 的浏览器半边：设置 → 安全 页面。
 *
 * ## 为什么是这样一份文件
 *
 * 这是动态 Client 插件，由宿主的模块加载器以
 * `window.__ModuleLoader__.load({ id, factory })` 形式执行，`factory` 拿到一个
 * `require`，从共享模块表取平台模块（这里只需要 `react`）。因此它不经过任何
 * 打包步骤——一份自包含脚本就是完整产物。
 *
 * ## 结构
 *
 * `SecuritySection` 只负责状态与请求，渲染全部交给纯函数 {@link SecurityView}。
 * 这样视图可以直接被渲染测试覆盖——文案键写错、分支抛异常都能在发布前抓到，
 * 而不是等到界面上出现一块空白。
 *
 * `t` 来自 locale 服务的 `bind()`，**是函数** `t('key', params)`，不是键值对象。
 * 属性式访问（`t.loading`）永远得到 undefined——那会让界面整页空白，所以这里
 * 统一经过 {@link translator}，并回退成键名。
 */

window.__ModuleLoader__.load({
  id: 'dsh-web-password-auth',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    // ── 样式 ──────────────────────────────────────────────────────────────
    // 用 --dsw-alias-* 语义 token，跟随主题；带 data 标记，重复加载不叠加。
    const CSS = [
      '.wpa_page{display:flex;flex-direction:column;gap:18px;padding:4px 0 24px;max-width:560px}',
      '.wpa_block{display:flex;flex-direction:column;gap:10px}',
      '.wpa_title{margin:0;font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.wpa_desc{margin:0;font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.wpa_field{display:flex;flex-direction:column;gap:6px}',
      '.wpa_label{font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.wpa_input{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border-radius:8px;',
      'border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.wpa_input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.wpa_row{display:flex;align-items:center;gap:10px}',
      '.wpa_rowEnd{justify-content:flex-end}',
      '.wpa_button{height:32px;padding:0 14px;border-radius:8px;font:inherit;font-size:13px;cursor:pointer;',
      'border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);',
      'color:var(--dsw-alias-label-primary)}',
      '.wpa_button:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.wpa_primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}',
      '.wpa_danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.wpa_status{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary)}',
      '.wpa_dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}',
      '.wpa_dotOff{background:var(--dsw-alias-label-tertiary)}',
      '.wpa_msg{margin:0;font-size:13px;line-height:18px}',
      '.wpa_error{color:var(--dsw-alias-state-error-primary)}',
      '.wpa_ok{color:var(--dsw-alias-state-success-primary)}',
      '.wpa_qr{display:block;width:220px;height:220px;margin:4px 0 8px;border-radius:8px;',
      'background:#fff;padding:8px;box-sizing:content-box}',
      '.wpa_secret{display:block;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);',
      'border:.5px solid var(--dsw-alias-border-l2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;',
      'font-size:13px;line-height:18px;word-break:break-all;user-select:all;color:var(--dsw-alias-label-primary)}',
      '.wpa_uri{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-all;margin:0}',
      '.wpa_divider{height:1px;background:var(--dsw-alias-border-l1);margin:2px 0}',
    ].join('')

    const CSS_TAG = 'dsh-web-password-auth/security.css'
    if (typeof document !== 'undefined'
      && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-web-password-auth'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── 文案 ──────────────────────────────────────────────────────────────

    /** 字典命名空间。 */
    const NS = 'web-password-auth'

    const ZH = {
      nav: '安全',
      heading: '登录与安全',
      intro: '这台 Harness 用用户名和密码登录。启动时打印的网址仍可作为本机备用入口，用于忘记密码时进入。',
      account: '账户',
      signedInAs: '当前登录：{username}',
      sessionNote: '会话有效期 {days} 天，之后需要重新登录。',
      setupTitle: '创建密码账户',
      setupIntro: '你现在是通过启动令牌进来的。设置用户名和密码后，下次可以直接用它们登录。令牌仍然可用作本机备用入口。',
      createAccount: '创建账户',
      accountExists: '账户已存在。',
      createdAccount: '账户已创建，下次可以用用户名和密码登录。',
      noAccount: '尚未创建账户。',
      usernameLabel: '用户名',
      changeUsername: '保存用户名',
      usernameHint: '显示在登录页，也用作验证器里的条目名。',
      usernameInvalid: '请使用 1-64 位字母、数字、点、短横线或下划线。',
      usernameChanged: '用户名已修改。',
      scanHint: '用验证器 App 扫描，或手动输入密钥。',
      changePassword: '修改密码',
      newPassword: '新密码',
      confirmPassword: '确认新密码',
      save: '保存',
      twoFactor: '两步验证',
      twoFactorOn: '两步验证已开启',
      twoFactorOff: '两步验证已关闭',
      twoFactorIntro: '开启后，每次密码登录还需要输入验证器 App 里的 6 位验证码。',
      enable: '开启',
      disable: '关闭',
      confirmCode: '6 位验证码',
      setupHint: '把这个密钥加到验证器 App，然后输入当前验证码确认。',
      secret: '密钥',
      cancel: '取消',
      confirm: '确认',
      signOut: '退出登录',
      signOutHint: '退出会立即让当前会话失效，下次访问需要重新登录。',
      passwordTooShort: '密码至少 {min} 个字符。',
      passwordsDoNotMatch: '两次输入的密码不一致。',
      wrongTotp: '验证码错误或已使用。',
      totpEnabled: '两步验证已开启。',
      totpDisabled: '两步验证已关闭。',
      loading: '读取中…',
      saveFailed: '保存失败，请重试。',
      loadFailed: '读取状态失败。',
      retry: '重试',
    }

    const EN = {
      nav: 'Security',
      heading: 'Sign-in and security',
      intro: 'This harness signs in with a username and password. The URL printed at startup still works as a local fallback when the password is forgotten.',
      account: 'Account',
      signedInAs: 'Signed in as {username}',
      sessionNote: 'Sessions last {days} days, then you sign in again.',
      setupTitle: 'Create a password account',
      setupIntro: 'You are signed in with the launch token. Set a username and password so you can sign in with them next time; the token keeps working as a local fallback.',
      createAccount: 'Create account',
      accountExists: 'An account already exists.',
      createdAccount: 'Account created. You can sign in with it next time.',
      noAccount: 'No account has been created yet.',
      usernameLabel: 'Username',
      changeUsername: 'Save username',
      usernameHint: 'Shown on the sign-in screen and as your authenticator entry.',
      usernameInvalid: 'Use 1-64 letters, digits, dots, dashes or underscores.',
      usernameChanged: 'Username changed.',
      scanHint: 'Scan this, or enter the key manually.',
      changePassword: 'Change password',
      newPassword: 'New password',
      confirmPassword: 'Confirm new password',
      save: 'Save',
      twoFactor: 'Two-factor authentication',
      twoFactorOn: 'Two-factor authentication is on',
      twoFactorOff: 'Two-factor authentication is off',
      twoFactorIntro: 'When on, every password sign-in also asks for the 6-digit code from your authenticator app.',
      enable: 'Turn on',
      disable: 'Turn off',
      confirmCode: '6-digit code',
      setupHint: 'Add this secret to your authenticator app, then enter the current code to confirm.',
      secret: 'Secret key',
      cancel: 'Cancel',
      confirm: 'Confirm',
      signOut: 'Sign out',
      signOutHint: 'Signing out revokes this session immediately; the next visit asks for the password again.',
      passwordTooShort: 'Use at least {min} characters.',
      passwordsDoNotMatch: 'The two passwords do not match.',
      wrongTotp: 'Wrong or already-used code.',
      totpEnabled: 'Two-factor authentication is on.',
      totpDisabled: 'Two-factor authentication is off.',
      loading: 'Loading…',
      saveFailed: 'Could not save. Try again.',
      loadFailed: 'Could not read the current state.',
      retry: 'Retry',
    }

    /**
     * 把 locale 的 `t` 包成本插件用的翻译器。
     *
     * `t` 是 `t(key, params) => string`，属性访问拿不到任何东西；所以统一走函数
     * 调用，并把取不到的情况回退成键名，绝不让 undefined 流进元素。
     * @param {Function|object|undefined} source - locale 绑定函数，或（测试时的）字典对象。
     * @returns {(key: string, params?: object) => string} 翻译器。
     */
    const translator = (source) => (key, params) => {
      let text
      if (typeof source === 'function') text = source(key, params)
      else if (source !== undefined && source !== null) text = source[key]
      if (typeof text !== 'string' || text === '') text = key
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/g, (whole, name) => (
        params[name] === undefined ? whole : String(params[name])))
    }

    // ── 数据访问 ──────────────────────────────────────────────────────────

    /** 端点前缀。页面挂在 `/`，相对路径即解析到根下。 */
    const BASE = 'web-auth'

    /**
     * 调用一个 JSON 端点。
     * @param {string} path - 相对端点。
     * @param {object} [options] - fetch 选项。
     * @returns {Promise<object>} 状态码与解析后的响应体。
     */
    const call = async (path, options) => {
      const response = await fetch(BASE + path, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      let body = {}
      try {
        body = await response.json()
      } catch {
        body = {}
      }
      return { status: response.status, ...body }
    }

    // ── 纯视图 ────────────────────────────────────────────────────────────

    /**
     * 渲染安全设置页。纯函数：只读入参与回调，不订阅、不发请求。
     * @param {object} props - 视图输入。
     * @param {Function} props.tr - 翻译器。
     * @param {'loading'|'failed'|'ready'} props.phase - 页面阶段。
     * @param {object} [props.status] - `/status` 的响应。
     * @param {boolean} props.busy - 是否有请求在飞。
     * @param {string} [props.error] - 已翻译的错误文案。
     * @param {string} [props.notice] - 已翻译的成功提示。
     * @param {object} props.form - 表单当前值。
     * @param {object} [props.pending] - 待确认的两步验证密钥。
     * @param {object} props.actions - 回调集合。
     * @returns {object} React 元素。
     */
    function SecurityView(props) {
      const { tr, phase, busy, error, notice, form, pending, actions } = props
      const status = props.status ?? {}
      const el = react.createElement

      if (phase === 'loading') {
        return el('div', { className: 'wpa_page' },
          el('p', { className: 'wpa_desc' }, tr('loading')))
      }
      if (phase === 'failed') {
        return el('div', { className: 'wpa_page' },
          el('p', { className: 'wpa_msg wpa_error' }, tr('loadFailed')),
          el('div', { className: 'wpa_row wpa_rowEnd' },
            el('button', { className: 'wpa_button', onClick: actions.reload }, tr('retry'))))
      }

      // 用启动令牌进来时会话已存在、账户却还没有：这时唯一该做的事是建账户。
      const hasAccount = status.hasAccount !== false
      const totpEnabled = status.totpEnabled === true
      // 用户名草稿可能尚未初始化（首帧或测试直接渲染视图），兜底成服务端值。
      const usernameDraft = form.username ?? status.username ?? ''

      if (!hasAccount) {
        return el('div', { className: 'wpa_page' },
          el('div', { className: 'wpa_block' },
            el('h2', { className: 'wpa_title' }, tr('setupTitle')),
            el('p', { className: 'wpa_desc' }, tr('setupIntro'))),
          el('div', { className: 'wpa_block' },
            el('div', { className: 'wpa_field' },
              el('label', { className: 'wpa_label', htmlFor: 'wpa-new-user' }, tr('usernameLabel')),
              el('input', {
                id: 'wpa-new-user', className: 'wpa_input', type: 'text', maxLength: 64,
                value: usernameDraft, disabled: busy, autoComplete: 'username',
                onChange: event => actions.setUsername(event.target.value),
              })),
            el('div', { className: 'wpa_field' },
              el('label', { className: 'wpa_label', htmlFor: 'wpa-new-pw' }, tr('newPassword')),
              el('input', {
                id: 'wpa-new-pw', className: 'wpa_input', type: 'password', value: form.password,
                disabled: busy, autoComplete: 'new-password',
                onChange: event => actions.setPassword(event.target.value),
              })),
            el('div', { className: 'wpa_field' },
              el('label', { className: 'wpa_label', htmlFor: 'wpa-new-pw2' }, tr('confirmPassword')),
              el('input', {
                id: 'wpa-new-pw2', className: 'wpa_input', type: 'password', value: form.confirm,
                disabled: busy, autoComplete: 'new-password',
                onChange: event => actions.setConfirm(event.target.value),
              })),
            el('div', { className: 'wpa_row wpa_rowEnd' },
              el('button', {
                className: 'wpa_button wpa_primary', onClick: actions.submitSetup,
                disabled: busy || usernameDraft.trim() === '' || form.password === '',
              }, tr('createAccount')))),
          error === undefined ? null : el('p', { className: 'wpa_msg wpa_error' }, error),
          notice === undefined ? null : el('p', { className: 'wpa_msg wpa_ok' }, notice))
      }

      /** 一个带标签的输入行。 */
      const field = (id, label, type, value, onChange) => el('div', { className: 'wpa_field' },
        el('label', { className: 'wpa_label', htmlFor: id }, label),
        el('input', {
          id, className: 'wpa_input', type, value, disabled: busy, onChange,
          autoComplete: 'new-password',
        }))

      /** 6 位验证码输入。 */
      const codeInput = (id) => el('input', {
        id, className: 'wpa_input', inputMode: 'numeric', maxLength: 6, placeholder: '000000',
        value: form.code, disabled: busy,
        onChange: event => actions.setCode(String(event.target.value).replace(/\D/gu, '')),
      })

      const totpBlock = pending === undefined
        ? (totpEnabled
          ? el('div', { className: 'wpa_block' },
            el('div', { className: 'wpa_field' },
              el('label', { className: 'wpa_label', htmlFor: 'wpa-code-off' }, tr('confirmCode')),
              codeInput('wpa-code-off')),
            el('div', { className: 'wpa_row wpa_rowEnd' },
              el('button', {
                className: 'wpa_button wpa_danger', onClick: actions.disableTotp,
                disabled: busy || form.code.length !== 6,
              }, tr('disable'))))
          : el('div', { className: 'wpa_row wpa_rowEnd' },
            el('button', { className: 'wpa_button', onClick: actions.beginTotp, disabled: busy }, tr('enable'))))
        : el('div', { className: 'wpa_block' },
          el('p', { className: 'wpa_desc' }, tr('setupHint')),
          pending.qrDataUri === undefined
            ? null
            : el('img', {
              className: 'wpa_qr', src: pending.qrDataUri, alt: tr('setupHint'),
              width: 220, height: 220,
            }),
          el('p', { className: 'wpa_desc' }, tr('scanHint')),
          el('label', { className: 'wpa_label' }, tr('secret')),
          el('code', { className: 'wpa_secret' }, pending.secret),
          el('p', { className: 'wpa_uri' }, pending.uri),
          el('div', { className: 'wpa_field' },
            el('label', { className: 'wpa_label', htmlFor: 'wpa-code-on' }, tr('confirmCode')),
            codeInput('wpa-code-on')),
          el('div', { className: 'wpa_row wpa_rowEnd' },
            el('button', { className: 'wpa_button', onClick: actions.cancelTotp, disabled: busy }, tr('cancel')),
            el('button', {
              className: 'wpa_button wpa_primary', onClick: actions.confirmTotp,
              disabled: busy || form.code.length !== 6,
            }, tr('confirm'))))

      return el('div', { className: 'wpa_page' },
        el('div', { className: 'wpa_block' },
          el('h2', { className: 'wpa_title' }, tr('heading')),
          el('p', { className: 'wpa_desc' }, tr('intro'))),

        el('div', { className: 'wpa_block' },
          el('h3', { className: 'wpa_title' }, tr('account')),
          el('p', { className: 'wpa_desc' }, tr('signedInAs', { username: status.username ?? '' })),
          el('p', { className: 'wpa_desc' }, tr('sessionNote', { days: String(status.sessionDays ?? '') })),
          el('div', { className: 'wpa_field' },
            el('label', { className: 'wpa_label', htmlFor: 'wpa-user' }, tr('usernameLabel')),
            el('input', {
              id: 'wpa-user', className: 'wpa_input', type: 'text', maxLength: 64,
              value: usernameDraft, disabled: busy,
              onChange: event => actions.setUsername(event.target.value),
            })),
          el('p', { className: 'wpa_desc' }, tr('usernameHint')),
          el('div', { className: 'wpa_row wpa_rowEnd' },
            el('button', {
              className: 'wpa_button', onClick: actions.submitUsername,
              disabled: busy || usernameDraft.trim() === '' || usernameDraft.trim() === (status.username ?? ''),
            }, tr('changeUsername')))),

        el('div', { className: 'wpa_block' },
          el('h3', { className: 'wpa_title' }, tr('changePassword')),
          field('wpa-pw', tr('newPassword'), 'password', form.password,
            event => actions.setPassword(event.target.value)),
          field('wpa-pw2', tr('confirmPassword'), 'password', form.confirm,
            event => actions.setConfirm(event.target.value)),
          el('div', { className: 'wpa_row wpa_rowEnd' },
            el('button', {
              className: 'wpa_button wpa_primary', onClick: actions.submitPassword,
              disabled: busy || form.password === '',
            }, tr('save')))),

        el('div', { className: 'wpa_divider' }),

        el('div', { className: 'wpa_block' },
          el('h3', { className: 'wpa_title' }, tr('twoFactor')),
          el('div', { className: 'wpa_status' },
            el('span', { className: totpEnabled ? 'wpa_dot' : 'wpa_dot wpa_dotOff' }),
            el('span', undefined, totpEnabled ? tr('twoFactorOn') : tr('twoFactorOff'))),
          el('p', { className: 'wpa_desc' }, tr('twoFactorIntro')),
          totpBlock),

        error === undefined ? null : el('p', { className: 'wpa_msg wpa_error' }, error),
        notice === undefined ? null : el('p', { className: 'wpa_msg wpa_ok' }, notice),

        el('div', { className: 'wpa_divider' }),

        el('div', { className: 'wpa_block' },
          el('h3', { className: 'wpa_title' }, tr('signOut')),
          el('p', { className: 'wpa_desc' }, tr('signOutHint')),
          el('div', { className: 'wpa_row wpa_rowEnd' },
            el('button', { className: 'wpa_button wpa_danger', onClick: actions.signOut, disabled: busy },
              tr('signOut')))))
    }

    // ── 有状态外壳 ────────────────────────────────────────────────────────

    /**
     * 设置 → 安全 一节。持有状态与请求，渲染交给 {@link SecurityView}。
     * @param {object} props - slot props；`t` 由 `locale:` 注册声明注入。
     * @returns {object} React 元素。
     */
    function SecuritySection(props) {
      const tr = react.useMemo(() => translator(props?.t), [props?.t])
      const [phase, setPhase] = react.useState('loading')
      const [status, setStatus] = react.useState(undefined)
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState(undefined)
      const [notice, setNotice] = react.useState(undefined)
      const [pending, setPending] = react.useState(undefined)
      const [form, setForm] = react.useState({ username: '', password: '', confirm: '', code: '' })

      const setPassword = react.useCallback(value => setForm(current => ({ ...current, password: value })), [])
      const setConfirm = react.useCallback(value => setForm(current => ({ ...current, confirm: value })), [])
      const setCode = react.useCallback(value => setForm(current => ({ ...current, code: value })), [])
      const setUsername = react.useCallback(value => setForm(current => ({ ...current, username: value })), [])

      const reload = react.useCallback(() => {
        setPhase('loading')
        void call('/status')
          .then((body) => {
            if (body.ok !== true) { setPhase('failed'); return }
            setStatus(body)
            setPhase('ready')
            // 用户名输入框以服务端值为初值；页面刷新后不会残留旧草稿。
            setForm(current => ({ ...current, username: body.username ?? '' }))
          })
          .catch(() => setPhase('failed'))
      }, [])

      react.useEffect(() => { reload() }, [reload])

      /** 统一维护 busy 与错误提示。 */
      const run = async (operation) => {
        setBusy(true)
        setError(undefined)
        setNotice(undefined)
        try {
          await operation()
        } catch {
          setError(tr('saveFailed'))
        } finally {
          setBusy(false)
        }
      }

      const minLength = status?.minPasswordLength ?? 8

      const submitSetup = () => {
        void run(async () => {
          if (form.password !== form.confirm) { setError(tr('passwordsDoNotMatch')); return }
          const body = await call('/setup', {
            method: 'POST',
            body: JSON.stringify({
              username: form.username, password: form.password, confirm: form.confirm,
            }),
          })
          if (body.status === 401) { window.location.replace('login'); return }
          if (body.ok !== true) {
            setError(body.error === 'passwordTooShort' ? tr('passwordTooShort', { min: minLength })
              : body.error === 'passwordsDoNotMatch' ? tr('passwordsDoNotMatch')
                : body.error === 'usernameInvalid' ? tr('usernameInvalid')
                  : body.error === 'accountExists' ? tr('accountExists')
                    : tr('saveFailed'))
            return
          }
          setForm(current => ({ ...current, password: '', confirm: '' }))
          setNotice(tr('createdAccount'))
          reload()
        })
      }

      const submitUsername = () => {
        void run(async () => {
          const body = await call('/username', {
            method: 'POST',
            body: JSON.stringify({ username: form.username }),
          })
          if (body.status === 401) { window.location.replace('login'); return }
          if (body.ok !== true) {
            setError(body.error === 'usernameInvalid' ? tr('usernameInvalid') : tr('saveFailed'))
            return
          }
          setNotice(tr('usernameChanged'))
          reload()
        })
      }

      const submitPassword = () => {
        void run(async () => {
          if (form.password.length < minLength) { setError(tr('passwordTooShort', { min: minLength })); return }
          if (form.password !== form.confirm) { setError(tr('passwordsDoNotMatch')); return }
          const body = await call('/password', {
            method: 'POST',
            body: JSON.stringify({ password: form.password, confirm: form.confirm }),
          })
          if (body.status === 401) { window.location.replace('login'); return }
          if (body.ok !== true) {
            setError(body.error === 'passwordTooShort' ? tr('passwordTooShort', { min: minLength })
              : body.error === 'passwordsDoNotMatch' ? tr('passwordsDoNotMatch')
                : tr('saveFailed'))
            return
          }
          // 改密码会吊销全部会话，包括当前这个。
          window.location.replace('login')
        })
      }

      const beginTotp = () => {
        void run(async () => {
          const body = await call('/totp/begin', { method: 'POST' })
          if (body.ok !== true) { setError(tr('saveFailed')); return }
          setPending({ secret: body.secret, uri: body.otpauthUri, qrDataUri: body.qrDataUri })
          setForm(current => ({ ...current, code: '' }))
        })
      }

      const confirmTotp = () => {
        void run(async () => {
          const body = await call('/totp/confirm', { method: 'POST', body: JSON.stringify({ code: form.code }) })
          if (body.ok !== true) { setError(body.error === 'wrongTotp' ? tr('wrongTotp') : tr('saveFailed')); return }
          setPending(undefined)
          setForm(current => ({ ...current, code: '' }))
          setNotice(tr('totpEnabled'))
          reload()
        })
      }

      const disableTotp = () => {
        void run(async () => {
          const body = await call('/totp/disable', { method: 'POST', body: JSON.stringify({ code: form.code }) })
          if (body.ok !== true) { setError(body.error === 'wrongTotp' ? tr('wrongTotp') : tr('saveFailed')); return }
          setForm(current => ({ ...current, code: '' }))
          setNotice(tr('totpDisabled'))
          reload()
        })
      }

      const signOut = () => {
        void run(async () => {
          await call('/logout', { method: 'POST' })
          window.location.replace('login')
        })
      }

      const cancelTotp = () => {
        void run(async () => {
          // 不留下未确认的草稿：否则下次点「开启」前，记录里会一直挂着一个
          // 从未生效的密钥。
          await call('/totp/cancel', { method: 'POST', body: '{}' })
          setPending(undefined)
          setForm(current => ({ ...current, code: '' }))
          reload()
        })
      }

      return react.createElement(SecurityView, {
        tr, phase, status, busy, error, notice, form, pending,
        actions: {
          reload, submitSetup, submitPassword, submitUsername, beginTotp, confirmTotp, disableTotp, cancelTotp, signOut,
          setPassword, setConfirm, setCode, setUsername,
        },
      })
    }

    // ── 注册 ──────────────────────────────────────────────────────────────

    /** 本插件实际用到的服务；多写会因等待不存在的服务而让整个界面不渲染。 */
    const inject = ['slots', 'locale']

    /**
     * 注册字典与设置页。
     * @param {object} ctx - Client 插件上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'web-password-auth: dictionaries')
      const bound = ctx.locale.bind(NS)

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'web-password-auth',
        order: 25,
        label: () => translator(bound)('nav'),
        locale: NS,
      }, SecuritySection))
    }

    exports.apply = apply
    exports.inject = inject
    exports.SecuritySection = SecuritySection
    exports.SecurityView = SecurityView
    exports.translator = translator
    exports.ZH = ZH
    exports.EN = EN
    return module.exports
  },
})
