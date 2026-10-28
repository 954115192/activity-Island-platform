// 阶段 C 验收：脚手架 → 打包 → 安装 → 日志 → 热重载 → 未加载原因。
// 只用 Node（PluginManager / PluginLogger 都不依赖 Electron），不启动 UI。
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PluginManager } = require('../../dist-electron/plugins/plugin-manager.js')
const { PluginLogger } = require('../../dist-electron/plugins/plugin-logger.js')

const repo = path.resolve(__dirname, '..', '..')
const results = []
const test = (name, fn) => { try { fn(); results.push({ name, ok: true }) } catch (error) { results.push({ name, ok: false, detail: String(error?.message ?? error) }) } }

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'island-phase-c-'))
const devRoot = path.join(sandbox, 'island-plugin')
const userRoot = path.join(sandbox, 'user', 'plugins')
const logsRoot = path.join(sandbox, 'user', 'island-plugins', 'logs')
fs.mkdirSync(devRoot, { recursive: true })

// 1) 脚手架：从模板生成插件
execFileSync(process.execPath, [path.join(repo, 'scripts', 'new-plugin.mjs'), 'hello-probe', '你好探针', devRoot], { stdio: 'pipe' })
const devPlugin = path.join(devRoot, 'hello-probe')

test('脚手架生成插件（占位符已替换）', () => {
  assert.ok(fs.existsSync(path.join(devPlugin, 'plugin.json')), 'plugin.json 应该存在')
  assert.ok(fs.existsSync(path.join(devPlugin, 'dist', 'app.js')), 'dist/app.js 应该存在')
  const manifest = JSON.parse(fs.readFileSync(path.join(devPlugin, 'plugin.json'), 'utf8'))
  assert.equal(manifest.id, 'hello-probe')
  assert.equal(manifest.name, '你好探针')
  const app = fs.readFileSync(path.join(devPlugin, 'dist', 'app.js'), 'utf8')
  assert.ok(!app.includes('__ID__') && !app.includes('__NAME__'), '不应残留占位符')
  assert.ok(app.includes('hello-probe 已接入契约'), 'id 应该被写进源码')
})

// 2) 安装（记录源码目录 → 之后可热重载）
const manager = new PluginManager([userRoot], userRoot)
manager.discover()
const installed = manager.installDirectory(devPlugin)
test('安装插件并记录源码目录', () => {
  assert.equal(installed.manifest.id, 'hello-probe')
  assert.equal(manager.sourceOf('hello-probe'), devPlugin)
  assert.ok(fs.existsSync(installed.entryPath), '安装后的入口应该存在')
  assert.ok(fs.existsSync(path.join(userRoot, 'sources.json')), '应该写 sources.json')
})

// 3) 热重载用的同步：改开发目录 → syncFromSource
test('开发目录改动可同步到安装目录', () => {
  const file = path.join(devPlugin, 'dist', 'app.js')
  fs.appendFileSync(file, '\n// hot reload marker\n', 'utf8')
  assert.equal(manager.syncFromSource('hello-probe'), true)
  const copied = fs.readFileSync(path.join(userRoot, 'hello-probe', 'dist', 'app.js'), 'utf8')
  assert.ok(copied.includes('hot reload marker'), '同步后安装目录应该包含新内容')
})

// 4) 日志
test('插件日志写入与读取、清空', () => {
  const logger = new PluginLogger(logsRoot)
  logger.append('hello-probe', 'info', 'hello')
  logger.append('hello-probe', 'error', { reason: 'boom' })
  const lines = logger.tail('hello-probe')
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes('[info] hello'))
  assert.ok(lines[1].includes('"reason":"boom"'))
  assert.ok(fs.existsSync(path.join(logsRoot, 'hello-probe.log')))
  logger.clear('hello-probe')
  assert.deepEqual(logger.tail('hello-probe'), [])
})

// 5) 打包成 .islandplugin
const packOut = path.join(sandbox, 'hello-probe-0.1.0.islandplugin')
test('打包 .islandplugin（zip 内含 plugin.json 与 dist）', () => {
  execFileSync('pwsh', ['-NoProfile', '-File', path.join(devPlugin, 'pack.ps1'), '-Out', packOut], { stdio: 'pipe' })
  assert.ok(fs.existsSync(packOut), '包应该生成')
  const entries = execFileSync('pwsh', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead('${packOut.replace(/'/g, "''")}').Entries.FullName -join ','`], { encoding: 'utf8' })
  assert.ok(entries.includes('plugin.json'), `包内应有 plugin.json：${entries}`)
  assert.ok(entries.includes('dist/app.js'), `包内应有 dist/app.js：${entries}`)
})

// 6) 从包安装（宿主用 Expand-Archive 解开后按普通目录安装）
test('从 .islandplugin 解包并安装', () => {
  const extract = path.join(sandbox, 'extract')
  execFileSync('pwsh', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${packOut}' -DestinationPath '${extract}' -Force`], { stdio: 'pipe' })
  const root = [extract, ...fs.readdirSync(extract, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(extract, e.name))]
    .find(dir => fs.existsSync(path.join(dir, 'plugin.json')))
  assert.ok(root, '解出来的目录里应有 plugin.json')
  const manager2 = new PluginManager([userRoot], userRoot)
  manager2.discover()
  manager2.uninstall('hello-probe')
  const fromPackage = manager2.installDirectory(root, { link: false })
  assert.equal(fromPackage.manifest.id, 'hello-probe')
  assert.equal(manager2.sourceOf('hello-probe'), undefined, '从包安装不记录源码目录')
})

// 7) 未加载原因要可见（以前是静默跳过）
test('发现阶段的问题可读（缺 entry / 非法 id / 坏 JSON）', () => {
  const broken = path.join(userRoot, 'broken-entry')
  fs.mkdirSync(broken, { recursive: true })
  fs.writeFileSync(path.join(broken, 'plugin.json'), JSON.stringify({ id: 'broken-entry', name: 'x', version: '1.0.0', entry: 'dist/missing.html' }))
  const badId = path.join(userRoot, 'Bad-Id')
  fs.mkdirSync(badId, { recursive: true })
  fs.writeFileSync(path.join(badId, 'plugin.json'), JSON.stringify({ id: 'Bad-Id', name: 'x', version: '1.0.0', entry: 'dist/index.html' }))
  const badJson = path.join(userRoot, 'bad-json')
  fs.mkdirSync(badJson, { recursive: true })
  fs.writeFileSync(path.join(badJson, 'plugin.json'), '{ not json')
  const manager3 = new PluginManager([userRoot], userRoot)
  manager3.discover()
  const issues = manager3.issues()
  const reasons = issues.map(issue => `${issue.id ?? '?'}:${issue.reason}`)
  assert.ok(reasons.some(r => r.startsWith('broken-entry:') && r.includes('入口文件不存在')), `应有入口缺失原因：${reasons}`)
  assert.ok(reasons.some(r => r.startsWith('Bad-Id:') && r.includes('id 必须是')), `应有 id 非法原因：${reasons}`)
  assert.ok(reasons.some(r => r.includes('不是合法 JSON')), `应有 JSON 解析失败原因：${reasons}`)
})

let failed = 0
console.log('=== 阶段 C 验收（脚手架 / 打包 / 安装 / 日志 / 热重载同步 / 未加载原因）===')
for (const item of results) {
  if (!item.ok) failed += 1
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `   [${item.detail}]` : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
fs.rmSync(sandbox, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
