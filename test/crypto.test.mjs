/**
 * crypto.mjs —— 密码学模块的单元测试。
 * 用 node:test 跑，无需额外依赖：`node test/crypto.mjs`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import {
  cookieName, decodeBase32, decodeBase64Url, encodeBase32, encodeBase64Url,
  generateTotpSecret, hashPassword, mintCookieValue, parseSigningSecret,
  readCookieValue, requestAuthority, totpAt, totpCounter, totpUri,
  verifyCookieValue, verifyPassword, verifyTotp, clearCookie, sessionCookie,
} from '../lib/crypto.js'

const AUTHORITY = '127.0.0.1:3080'
const MAX_AGE = 30 * 24 * 60 * 60 * 1000

test('base64url 往返与已知向量', () => {
  assert.equal(encodeBase64Url(Buffer.from('hello')), 'aGVsbG8')
  assert.deepEqual(decodeBase64Url('aGVsbG8'), Buffer.from('hello'))
  // 无填充，且 +/ 已替换
  assert.equal(encodeBase64Url(Buffer.from([0xfb, 0xff])), '-_8')
  assert.deepEqual(decodeBase64Url('-_8'), Buffer.from([0xfb, 0xff]))
  assert.equal(decodeBase64Url('!!'), undefined)
  assert.equal(decodeBase64Url('a'), undefined) // 长度 %4 === 1
})

test('base32 编解码（RFC 4648）', () => {
  // RFC 4648 §10 测试向量
  assert.equal(encodeBase32(Buffer.from('foobar')), 'MZXW6YTBOI')
  assert.deepEqual(decodeBase32('MZXW6YTBOI'), Buffer.from('foobar'))
  assert.deepEqual(decodeBase32('mzxw6ytboi'), Buffer.from('foobar')) // 大小写不敏感
  assert.equal(decodeBase32('MZXW6YTB1'), undefined) // 含非法字符
})

test('cookie 名由 authority 决定且可区分端口', () => {
  const a = cookieName('127.0.0.1:3080')
  const b = cookieName('127.0.0.1:3081')
  assert.match(a, /^dsh-auth-[A-Za-z0-9_-]+$/)
  assert.notEqual(a, b)
  // 同一 authority 稳定
  assert.equal(a, cookieName('127.0.0.1:3080'))
})

test('requestAuthority：HTTP 用 host:port，HTTPS 用 origin', () => {
  assert.equal(requestAuthority({ host: '127.0.0.1:3080' }, false), '127.0.0.1:3080')
  assert.equal(requestAuthority({ host: '127.0.0.1' }, false), '127.0.0.1')
  assert.equal(requestAuthority({ host: 'example.com:443' }, true), 'https://example.com')
  assert.equal(requestAuthority({}, false), undefined)
  assert.equal(requestAuthority({ host: '' }, false), undefined)
})

test('cookie 签发与验签往返', () => {
  const secret = randomBytes(32)
  const now = Date.now()
  const value = mintCookieValue(secret, AUTHORITY, now, now + MAX_AGE)
  assert.match(value, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)

  const payload = verifyCookieValue(value, secret, AUTHORITY, MAX_AGE, now + 1000)
  assert.ok(payload)
  assert.equal(payload.authority, AUTHORITY)
  assert.equal(payload.issuedAt, now)
})

test('cookie 验签拒绝：错密钥/错 authority/过期/未生效/超长', () => {
  const secret = randomBytes(32)
  const now = Date.now()
  const value = mintCookieValue(secret, AUTHORITY, now, now + MAX_AGE)

  assert.equal(verifyCookieValue(value, randomBytes(32), AUTHORITY, MAX_AGE, now + 1000), undefined, '错密钥')
  assert.equal(verifyCookieValue(value, secret, '127.0.0.1:9999', MAX_AGE, now + 1000), undefined, '不同 authority')
  assert.equal(verifyCookieValue(value, secret, AUTHORITY, MAX_AGE, now + MAX_AGE + 1), undefined, '已过期')
  assert.equal(verifyCookieValue(value, secret, AUTHORITY, MAX_AGE, now - 1), undefined, '尚未生效')
  assert.equal(verifyCookieValue(value, secret, AUTHORITY, MAX_AGE / 2, now + 1000), undefined, '超出 maxAge 上限')
})

test('cookie 验签拒绝篡改与畸形输入', () => {
  const secret = randomBytes(32)
  const now = Date.now()
  const value = mintCookieValue(secret, AUTHORITY, now, now + MAX_AGE)
  const [version, body, signature] = value.split('.')

  assert.equal(verifyCookieValue(`${version}.${body}x.${signature}`, secret, AUTHORITY, MAX_AGE, now + 1000), undefined, '篡改 body')
  assert.equal(verifyCookieValue(`${version}.${body}.${signature}x`, secret, AUTHORITY, MAX_AGE, now + 1000), undefined, '篡改签名')
  assert.equal(verifyCookieValue('v1.abc', secret, AUTHORITY, MAX_AGE, now + 1000), undefined, '段数不足')
  assert.equal(verifyCookieValue('v2.abc.def', secret, AUTHORITY, MAX_AGE, now + 1000), undefined, '错版本')
  assert.equal(verifyCookieValue(null, secret, AUTHORITY, MAX_AGE, now + 1000), undefined, '非字符串')
})

test('readCookieValue 只取指定名字', () => {
  assert.equal(readCookieValue('a=1; dsh-auth-xyz=v1.aaa.bbb; b=2', 'dsh-auth-xyz'), 'v1.aaa.bbb')
  assert.equal(readCookieValue('a=1; b=2', 'dsh-auth-xyz'), undefined)
  assert.equal(readCookieValue(undefined, 'x'), undefined)
})

test('sessionCookie 与 clearCookie 属性', () => {
  const expiresAt = Date.parse('2030-01-01T00:00:00Z')
  const c = sessionCookie('n', 'v', { expiresAt, maxAgeSeconds: 3600, secure: false })
  assert.match(c, /^n=v; Max-Age=3600; Path=\/; Expires=/)
  assert.match(c, /HttpOnly/)
  assert.match(c, /SameSite=Strict/)
  assert.doesNotMatch(c, /Secure/)

  assert.match(sessionCookie('n', 'v', { expiresAt, maxAgeSeconds: 1, secure: true }), /Secure$/)

  const cleared = clearCookie('n', false)
  assert.match(cleared, /^n=; Max-Age=0; Path=\//)
})

test('密码哈希往返', () => {
  const record = hashPassword('correct horse battery staple', { N: 1024 })
  assert.equal(record.algo, 'scrypt')
  assert.equal(record.N, 1024)
  assert.ok(verifyPassword('correct horse battery staple', record))
  assert.ok(!verifyPassword('wrong', record))
  assert.ok(!verifyPassword('', record))
})

test('密码哈希：同一密码两次结果不同（salt 随机）', () => {
  const a = hashPassword('same', { N: 1024 })
  const b = hashPassword('same', { N: 1024 })
  assert.notEqual(a.salt, b.salt)
  assert.notEqual(a.hash, b.hash)
  assert.ok(verifyPassword('same', a))
  assert.ok(verifyPassword('same', b))
})

test('密码校验对畸形记录返回 false 而不抛异常', () => {
  assert.equal(verifyPassword('x', null), false)
  assert.equal(verifyPassword('x', undefined), false)
  assert.equal(verifyPassword('x', { algo: 'bcrypt' }), false)
  assert.equal(verifyPassword('x', { algo: 'scrypt', salt: '!!', hash: 'aGk' }), false)
  assert.equal(verifyPassword('x', { algo: 'scrypt', N: -1, r: 8, p: 1, salt: '', hash: '' }), false)
})

test('非 ASCII 密码可用（UTF-8 处理）', () => {
  const record = hashPassword('密码🔐中文', { N: 1024 })
  assert.ok(verifyPassword('密码🔐中文', record))
  assert.ok(!verifyPassword('密码中文', record))
})

test('TOTP 对 RFC 6238 官方测试向量全部命中', () => {
  // RFC 6238 附录 B：密钥 "12345678901234567890"（ASCII），取 8 位结果的低 6 位
  const secret = Buffer.from('12345678901234567890', 'ascii')
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ]
  for (const [time, expected] of vectors) {
    assert.equal(totpAt(secret, Math.floor(time / 30)), expected, `T=${time}`)
  }
})

test('verifyTotp 接受当前窗口与 ±1，拒绝重放', () => {
  const secretBase32 = generateTotpSecret()
  const secret = decodeBase32(secretBase32)
  const now = 1_700_000_000_000
  const counter = totpCounter(now)

  for (const offset of [-1, 0, 1]) {
    const code = totpAt(secret, counter + offset)
    assert.equal(verifyTotp(secretBase32, code, 0, now), counter + offset, `offset ${offset}`)
  }

  // 已用过 counter 后，同一时间步及更早一律拒绝
  const code = totpAt(secret, counter)
  assert.equal(verifyTotp(secretBase32, code, counter, now), undefined, '重放被拒')
  assert.equal(verifyTotp(secretBase32, totpAt(secret, counter - 1), counter, now), undefined, '更早窗口被拒')
  assert.equal(verifyTotp(secretBase32, totpAt(secret, counter + 1), counter, now), counter + 1, '更晚窗口仍可用')
})

test('verifyTotp 拒绝畸形输入', () => {
  const secretBase32 = generateTotpSecret()
  assert.equal(verifyTotp(secretBase32, '12345', 0), undefined, '5 位')
  assert.equal(verifyTotp(secretBase32, '1234567', 0), undefined, '7 位')
  assert.equal(verifyTotp(secretBase32, 'abcdef', 0), undefined, '非数字')
  assert.equal(verifyTotp('!!!!', '123456', 0), undefined, '非法密钥')
})

test('generateTotpSecret 产出 20 字节且可解码', () => {
  const s = generateTotpSecret()
  assert.equal(s.length, 32) // 20 字节 = 32 个 base32 字符
  assert.equal(decodeBase32(s).byteLength, 20)
  assert.notEqual(s, generateTotpSecret())
})

test('totpUri 格式', () => {
  const uri = totpUri('ABCDEFGHIJKLMNOP', 'admin', 'DSH')
  assert.match(uri, /^otpauth:\/\/totp\/DSH%3Aadmin\?/)
  assert.match(uri, /secret=ABCDEFGHIJKLMNOP/)
  assert.match(uri, /digits=6/)
  assert.match(uri, /period=30/)
})

test('parseSigningSecret 解析宿主记录形状', () => {
  const secret = randomBytes(32)
  const record = { kind: 'grant', payload: { version: 1, secret: encodeBase64Url(secret) } }
  assert.deepEqual(parseSigningSecret(record), secret)
})

test('parseSigningSecret 拒绝畸形记录', () => {
  const good = encodeBase64Url(randomBytes(32))
  assert.equal(parseSigningSecret(undefined), undefined)
  assert.equal(parseSigningSecret(null), undefined)
  assert.equal(parseSigningSecret({ kind: 'api-key', payload: { version: 1, secret: good } }), undefined, 'kind 不对')
  assert.equal(parseSigningSecret({ kind: 'grant', payload: { version: 2, secret: good } }), undefined, '版本不对')
  assert.equal(parseSigningSecret({ kind: 'grant', payload: { version: 1, secret: encodeBase64Url(randomBytes(16)) } }), undefined, '长度不对')
  assert.equal(parseSigningSecret({ kind: 'grant', payload: { version: 1, secret: '!!!' } }), undefined, '非 base64url')
  assert.equal(parseSigningSecret({ kind: 'grant' }), undefined, 'payload 缺失')
})
