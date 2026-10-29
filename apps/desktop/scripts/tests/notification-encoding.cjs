'use strict'

// Exercise the published listener as a child process, just as Electron does.
// The diagnostic emits synthetic data and never reads the notification center.
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const executable = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../../build/notify-listener/notify-listener.exe')
const result = spawnSync(executable, ['--encoding-probe'], { windowsHide: true, timeout: 10000 })
if (result.error) throw result.error
assert.equal(result.status, 0, '通知监听器编码检查未正常退出')
const text = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout)
const value = JSON.parse(text.trim())
assert.equal(value.type, 'encoding-probe')
assert.equal(value.title, '中文通知')
assert.equal(value.content, '验证码 123456 · 😀')
console.log('通知监听器 UTF-8 输出检查通过')
