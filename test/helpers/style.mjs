import { readFileSync } from 'node:fs'

/**
 * 取出 client 模块里的样式表文本。
 *
 * client.js 是浏览器 bundle（`window.__ModuleLoader__.load`），不能在 Node 里
 * 直接执行，所以按字符串边界截取 STYLE 数组，供配色断言使用。
 * @returns {string} 拼接后的一份 CSS。
 */
export function STYLE_TEXT() {
  const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
  // STYLE 是一个由多个字符串片段拼起来的数组，取它到下一个 `].join('')` 的一段。
  const start = source.indexOf('const CSS = [')
  if (start === -1) throw new Error('client.js: CSS array not found')
  const end = source.indexOf("].join('')", start)
  if (end === -1) throw new Error('client.js: CSS array end not found')
  const block = source.slice(start, end)
  const parts = [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1])
  return parts.join('')
}
