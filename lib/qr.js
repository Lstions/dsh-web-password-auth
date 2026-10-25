/**
 * 二维码生成：把 `otpauth://` URI 变成可扫描的图形。
 *
 * 需要二维码是因为手抄 32 位 base32 密钥极易出错——这正是两步验证"开户成功、
 * 登录失败"最常见的来源。密钥文本仍然保留，供无法扫码时手动输入。
 *
 * 二维码由**没被认证拦截的登录页可见**，所以这里只用插件自己的依赖生成纯数据，
 * 不引用任何客户端资源。
 *
 * @module dsh-web-password-auth/lib/qr
 */

import qrcode from 'qrcode'

/** 输出边长（像素）。220 在 2 倍屏与打印下都够清晰。 */
const WIDTH = 220

/**
 * 把文本渲染成 SVG 字符串。
 *
 * 固定黑白配色而非跟随主题：二维码靠明暗对比被识别，深色主题下面板背景会让
 * 透明的浅色模块消失，导致"看起来有码、扫不出来"。
 * @param {string} text - 要编码的文本，通常是 otpauth URI。
 * @returns {Promise<string>} 自包含的 SVG 源码。
 */
export const qrSvg = (text) => qrcode.toString(text, {
  type: 'svg',
  margin: 1,
  width: WIDTH,
  errorCorrectionLevel: 'M',
  color: { dark: '#000000', light: '#ffffff' },
})

/**
 * 把文本渲染成可直接放进 `<img src>` 的 data URI。
 *
 * 用 data URI 而不是内联 SVG 标记：调用方（React 元素或 HTML 模板）都不必把
 * 生成结果塞进 innerHTML，避免任何注入面。
 * @param {string} text - 要编码的文本。
 * @returns {Promise<string>} `data:image/svg+xml;base64,...`。
 */
export const qrDataUri = async (text) => {
  const svg = await qrSvg(text)
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}
