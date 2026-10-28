import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTestTarget } from '../../apps/desktop/electron/notifications/test-target.ts'

const ENDPOINT = 'http://127.0.0.1:5720/api/v1/notifications'

test('留空回落到当前配置的端点', () => {
  const result = parseTestTarget('', ENDPOINT)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.host, '127.0.0.1')
  assert.equal(result.port, 5720)
  assert.equal(result.path, '/api/v1/notifications')
})

test('裸 IP 沿用配置的端口', () => {
  const result = parseTestTarget('192.168.1.3', ENDPOINT)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.host, '192.168.1.3')
  assert.equal(result.port, 5720)
})

test('IP:端口 指定端口', () => {
  const result = parseTestTarget('192.168.1.3:6000', ENDPOINT)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.host, '192.168.1.3')
  assert.equal(result.port, 6000)
})

test('完整 URL 保留路径与端口', () => {
  const result = parseTestTarget('http://10.0.0.8:7000/api/v1/notifications', ENDPOINT)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.host, '10.0.0.8')
  assert.equal(result.port, 7000)
  assert.equal(result.path, '/api/v1/notifications')
})

test('无端口的 URL 用协议默认端口', () => {
  const http = parseTestTarget('http://example.local', ENDPOINT)
  assert.equal(http.ok, true)
  if (http.ok) assert.equal(http.port, 80)

  const https = parseTestTarget('https://example.local', ENDPOINT)
  assert.equal(https.ok, true)
  if (https.ok) assert.equal(https.port, 443)
})

test('IPv6 用方括号写法', () => {
  const result = parseTestTarget('[::1]:5720', ENDPOINT)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.host, '::1')
  assert.equal(result.port, 5720)
})

test('非法端口与非法地址返回错误', () => {
  const badPort = parseTestTarget('192.168.1.3:99999', ENDPOINT)
  assert.equal(badPort.ok, false)

  const bad = parseTestTarget('http://', ENDPOINT)
  assert.equal(bad.ok, false)
})

test('端点缺失时用默认回环地址', () => {
  const result = parseTestTarget('', null)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.host, '127.0.0.1')
  assert.equal(result.port, 5720)
})
