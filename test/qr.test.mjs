/**
 * qr.test.mjs —— 二维码生成与**可解码性**测试。
 *
 * 只断言"输出里有 data URI"是不够的：一串看似正常但编码错误的图形，界面上看不出
 * 差别，用户扫码时才发现是废的。所以这里把生成的 SVG 还原成像素矩阵，交给真正的
 * 二维码解码器读回来，验证它编码的就是那份 otpauth URI。
 *
 * 还原方式：`qrcode` 的 SVG 用 `<path stroke="#000000" d="M1 1.5h7m7 0h1…">` 表达
 * 每一行里的深色游程——`M<x> <y>` 定位，`h<n>` 画 n 格宽，`m<dx> 0` 平移。按这个
 * 规则重建矩阵即可，不需要浏览器或图像库。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import jsQR from 'jsqr'

import { qrDataUri, qrSvg } from '../lib/qr.js'

// 一份真实的开户 URI：包含 URL 编码的冒号、密钥与参数，长度接近实际使用。
const URI = 'otpauth://totp/DSH%3Aadmin?secret=RSPIX5QWYXJLLADYESQT7X6WCVTV5VSD&issuer=DSH&algorithm=SHA1&digits=6&period=30'

/** 每个模块放大多少像素；8 足够让解码器稳定识别。 */
const SCALE = 8

/** 二维码四周必须留出的静区（模块数）。 */
const QUIET = 4

/**
 * 把生成的 SVG 还原成深/浅模块矩阵。
 *
 * `viewBox` 含二维码四周的静区，不能直接当模块数用——模块数从路径坐标自身推出，
 * 这样即使将来调整静区大小也不会算错。
 * @param {string} svg - `qrSvg` 的输出。
 * @returns {{ size: number, dark: (row: number, column: number) => boolean }} 矩阵访问器。
 */
function parseModules(svg) {
  assert.match(svg, /viewBox="0 0 \d+ \d+"/, 'SVG 缺少 viewBox')
  const darkPath = svg.match(/<path stroke="#000000" d="([^"]+)"/)
  assert.ok(darkPath, 'SVG 缺少深色模块路径')

  /** @type {{ row: number, start: number, length: number }[]} */
  const runs = []
  let x = 0
  let y = 0
  // 路径是一串绝对/相对移动 + 横线游程：`M x y`、`m dx dy` 只改变当前位置，
  // `h n` 才是"从这里往右 n 格是深色"。画出的是 y+0.5 的横线，覆盖 [y, y+1)，
  // 所以模块行是 floor(y)，模块列从 x 开始（两者都已减去静区）。
  for (const token of darkPath[1].match(/[Mmh][^Mmh]*/g) ?? []) {
    const command = token[0]
    const numbers = (token.slice(1).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    if (command === 'M') {
      x = numbers[0]
      y = numbers[1]
    } else if (command === 'm') {
      x += numbers[0]
      y += numbers[1]
    } else if (command === 'h') {
      runs.push({ row: Math.floor(y), start: Math.round(x), length: numbers[0] })
      x += numbers[0]
    } else {
      assert.fail(`未预期的路径命令：${command}`)
    }
  }
  assert.ok(runs.length > 0, '路径里没有深色模块')

  // 最小坐标是静区（通常 1），据此把坐标平移成从 0 开始的模块下标。
  const originRow = Math.min(...runs.map(run => run.row))
  const originColumn = Math.min(...runs.map(run => run.start))
  const size = Math.max(
    ...runs.map(run => run.row - originRow + 1),
    ...runs.map(run => run.start - originColumn + run.length),
  )

  const grid = Array.from({ length: size }, () => new Array(size).fill(false))
  for (const run of runs) {
    const row = run.row - originRow
    const start = run.start - originColumn
    for (let i = 0; i < run.length; i += 1) grid[row][start + i] = true
  }
  return { size, dark: (row, column) => grid[row]?.[column] === true }
}

/**
 * 把矩阵栅格化成解码器能吃的 RGBA 像素。
 * @param {{ size: number, dark: Function }} matrix - 模块矩阵。
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }} 像素。
 */
function rasterize(matrix) {
  const side = (matrix.size + QUIET * 2) * SCALE
  const data = new Uint8ClampedArray(side * side * 4)
  // 先铺白底（含静区）。
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255
    data[i + 1] = 255
    data[i + 2] = 255
    data[i + 3] = 255
  }
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      if (!matrix.dark(row, column)) continue
      for (let dy = 0; dy < SCALE; dy += 1) {
        for (let dx = 0; dx < SCALE; dx += 1) {
          const px = (QUIET + column) * SCALE + dx
          const py = (QUIET + row) * SCALE + dy
          const at = (py * side + px) * 4
          data[at] = 0
          data[at + 1] = 0
          data[at + 2] = 0
        }
      }
    }
  }
  return { data, width: side, height: side }
}

test('生成的二维码能被解码器读回原文', async () => {
  const svg = await qrSvg(URI)
  const matrix = parseModules(svg)
  const pixels = rasterize(matrix)
  const decoded = jsQR(pixels.data, pixels.width, pixels.height)
  assert.ok(decoded, '二维码无法被解码')
  assert.equal(decoded.data, URI, '二维码内容与 otpauth URI 不一致')
})

test('同一输入生成完全相同的输出（可缓存、可复现）', async () => {
  assert.equal(await qrSvg(URI), await qrSvg(URI))
  assert.equal(await qrDataUri(URI), await qrDataUri(URI))
})

test('不同密钥生成不同的二维码', async () => {
  const a = await qrSvg('otpauth://totp/x?secret=AAAAAAAA')
  const b = await qrSvg('otpauth://totp/x?secret=BBBBBBBB')
  assert.notEqual(a, b)
  // 但两者的结构必须一致：都是同尺寸的合法 SVG。
  assert.match(a, /^<svg[^>]+viewBox=/)
  assert.match(b, /^<svg[^>]+viewBox=/)
})

test('data URI 是可直接放进 img 的 SVG 编码', async () => {
  const uri = await qrDataUri(URI)
  assert.match(uri, /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/)
  const svg = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64').toString('utf8')
  assert.equal(svg, await qrSvg(URI), 'data URI 与 SVG 输出必须一致')
})

test('二维码固定黑白配色，深色主题下仍可扫描', async () => {
  const svg = await qrSvg(URI)
  // 透明或跟随主题的背景会让深色界面里的浅色模块消失，导致"有码却扫不出来"。
  assert.match(svg, /fill="#ffffff"/, '必须有不透明白色背景')
  assert.match(svg, /stroke="#000000"/, '深色模块必须是黑色')
})

test('矩阵里存在三个定位图案（左上、右上、左下）', async () => {
  const { size, dark } = parseModules(await qrSvg(URI))
  // 定位图案是 7×7 回字形：外框与中心 3×3 为深色，中间一圈为浅色。
  for (const [row, column] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    const at = (dr, dc) => (row + dr < size && column + dc < size ? dark(row + dr, column + dc) : undefined)
    for (const [dr, dc] of [[0, 0], [0, 6], [6, 0], [6, 6]]) {
      assert.equal(at(dr, dc), true, `定位图案外框缺失于 (${row + dr},${column + dc})`)
    }
    for (const [dr, dc] of [[1, 1], [1, 5], [5, 1], [5, 5], [1, 3], [3, 1]]) {
      assert.equal(at(dr, dc), false, `定位图案浅色环处应为浅色 (${row + dr},${column + dc})`)
    }
    for (const [dr, dc] of [[2, 2], [3, 3], [4, 4]]) {
      assert.equal(at(dr, dc), true, `定位图案中心应为深色 (${row + dr},${column + dc})`)
    }
  }
})
