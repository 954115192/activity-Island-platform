// 宿主自带 zip 实现的单元验收（node 直跑，不需要 Electron）。
//
// 为什么要自己实现：Compress-Archive 实测会随调用形态与目标扩展名给出不一致的结果
// （打包 .islandplugin 时从 Node 调用 exit 0，从另一个 PowerShell 里调用却报
//  "not a supported archive file format"；目标没有扩展名时 exit 0 但一个文件都没生成），
// 而且它的 stderr 容易被吞掉，用户只看到没有信息量的 "exit 1"。
//
// 自己实现的代价是必须证明**互操作**：我打的包别人（系统工具）要能解开，
// 别人以前打的包我也必须能读 —— 否则老用户手里的 .islandplugin 会全部失效。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { zipDirectory, readZipEntries, extractZip, isZipFile, crc32 } = require('../../dist-electron/plugins/zip.js')

const results = []
const test = (name, fn) => { try { fn(); results.push({ name, ok: true }) } catch (error) { results.push({ name, ok: false, detail: String(error?.message ?? error) }) } }

const SANDBOX = path.join(os.tmpdir(), 'island-zip-unit')
fs.rmSync(SANDBOX, { recursive: true, force: true })
const SOURCE = path.join(SANDBOX, 'plugin')
const OUT = path.join(SANDBOX, 'plugin-0.1.0.islandplugin')

function write(rel, content) {
  const file = path.join(SOURCE, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}
function ps(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })
}
const quote = (value) => `'${value.replace(/'/g, "''")}'`

/** 手工构造 zip：用来造出写入器不会产出的条目名（如 ../ 穿越）。 */
function buildZip(entries) {
  const zlib = require('node:zlib')
  const local = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const data = Buffer.from(entry.data)
    const crc = crc32(data)
    const compressed = zlib.deflateRawSync(data)
    const name = Buffer.from(entry.name, 'utf8')
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8)
    header.writeUInt16LE(0, 10); header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(name.length, 26); header.writeUInt16LE(0, 28)
    local.push(header, name, compressed)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(0, 12); record.writeUInt16LE(0x21, 14)
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(data.length, 24)
    record.writeUInt16LE(name.length, 28); record.writeUInt16LE(0, 30); record.writeUInt16LE(0, 32)
    record.writeUInt16LE(0, 34); record.writeUInt16LE(0, 36); record.writeUInt32LE(0, 38); record.writeUInt32LE(offset, 42)
    central.push(record, name)
    offset += 30 + name.length + compressed.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20)
  return Buffer.concat([...local, directory, end])
}

write('plugin.json', JSON.stringify({ id: 'zip-probe', name: 'Zip 探针', version: '0.1.0', entry: 'dist/index.html' }))
write('dist/index.html', '<!doctype html><html><body>zip</body></html>')
write('dist/app.js', 'console.log("zip probe")')
write('dist/中文名.txt', '非 ASCII 文件名也要能进出')
write('resources/emit.js', 'process.stdout.write("{}")')
write('assets/data.json', '{"a":1}')
write('node_modules/pkg/index.js', 'module.exports = 1')
write('state.json', '{"runtime":"junk"}')
write('debug.log', 'noise')

const skipOptions = {
  skipDir: name => name.startsWith('.') || name === 'node_modules',
  skipFile: name => name.startsWith('.') || name === 'state.json' || /\.log$/i.test(name),
}

test('crc32 与已知值一致（"123456789" → 0xCBF43926）', () => {
  assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926')
})

test('打包目录并能在包内列出条目（不套外层目录）', () => {
  const bytes = zipDirectory(SOURCE, OUT, skipOptions)
  assert.ok(bytes > 0, '写入字节数应当大于 0')
  assert.equal(fs.statSync(OUT).size, bytes)
  const names = readZipEntries(OUT).map(entry => entry.name).sort()
  assert.deepEqual(names, [
    'assets/data.json',
    'dist/app.js',
    'dist/index.html',
    'dist/中文名.txt',
    'plugin.json',
    'resources/emit.js',
  ])
})

test('内容无损（含非 ASCII 文件名与内容）', () => {
  const entries = readZipEntries(OUT)
  const byName = Object.fromEntries(entries.map(entry => [entry.name, entry.data.toString('utf8')]))
  assert.equal(byName['dist/app.js'], 'console.log("zip probe")')
  assert.equal(byName['dist/中文名.txt'], '非 ASCII 文件名也要能进出')
  assert.equal(JSON.parse(byName['plugin.json']).id, 'zip-probe')
})

test('压缩真的生效了（不是只存不压）', () => {
  const big = 'x'.repeat(20000)
  const dir = path.join(SANDBOX, 'big')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'big.txt'), big)
  const out = path.join(SANDBOX, 'big.zip')
  zipDirectory(dir, out)
  assert.ok(fs.statSync(out).size < big.length / 2, `压缩后 ${fs.statSync(out).size} 应当远小于 ${big.length}`)
})

test('解压还原目录结构，并跳过危险条目', () => {
  const target = path.join(SANDBOX, 'extract')
  const written = extractZip(OUT, target).sort()
  assert.deepEqual(written, ['assets/data.json', 'dist/app.js', 'dist/index.html', 'dist/中文名.txt', 'plugin.json', 'resources/emit.js'])
  assert.equal(fs.readFileSync(path.join(target, 'dist', 'app.js'), 'utf8'), 'console.log("zip probe")')
  assert.ok(fs.existsSync(path.join(target, 'dist', '中文名.txt')), '非 ASCII 文件名解出来也要在')
})

test('路径穿越的条目会被拒绝（包可以从别处拿到，不能写到目录外）', () => {
  const evil = path.join(SANDBOX, 'evil.zip')
  fs.writeFileSync(evil, buildZip([
    { name: 'good.txt', data: 'ok' },
    { name: '../escaped.txt', data: 'should not be written' },
    { name: 'nested/../../escaped2.txt', data: 'should not be written' },
    { name: 'C:/absolute.txt', data: 'should not be written' },
    { name: 'sub/inside.txt', data: 'ok' },
  ]))
  const target = path.join(SANDBOX, 'extract-evil')
  const written = extractZip(evil, target).sort()
  assert.deepEqual(written, ['good.txt', 'sub/inside.txt'], `只应写出安全条目，实际：${written.join(',')}`)
  assert.ok(fs.existsSync(path.join(target, 'good.txt')))
  assert.ok(fs.existsSync(path.join(target, 'sub', 'inside.txt')))
  assert.ok(!fs.existsSync(path.join(target, '..', 'escaped.txt')), '不该写到目标目录上一级')
  assert.ok(!fs.existsSync(path.join(SANDBOX, 'escaped.txt')), '不该写到沙箱根')
  assert.ok(!fs.existsSync(path.join(SANDBOX, 'escaped2.txt')), '不该被 nested/../.. 绕出去')
})

test('isZipFile 能挡住"拿错文件来安装"', () => {
  assert.equal(isZipFile(OUT), true)
  const txt = path.join(SANDBOX, 'not-a-package.txt')
  fs.writeFileSync(txt, 'this is not a zip')
  assert.equal(isZipFile(txt), false)
  assert.equal(isZipFile(path.join(SANDBOX, 'does-not-exist')), false)
})

// ---------------------------------------------------------------- 互操作（最关键的两条）

test('互操作：我打的包，系统 Expand-Archive 能解开', () => {
  const target = path.join(SANDBOX, 'ps-extract')
  fs.mkdirSync(target, { recursive: true })
  // 部分 PowerShell 版本只认 .zip 扩展名；先复制成 .zip 再解 —— 验的是包内容合法，不是扩展名。
  const zipCopy = path.join(SANDBOX, 'plugin-0.1.0.zip')
  fs.copyFileSync(OUT, zipCopy)
  ps(`Expand-Archive -LiteralPath ${quote(zipCopy)} -DestinationPath ${quote(target)} -Force`)
  assert.equal(fs.readFileSync(path.join(target, 'dist', 'app.js'), 'utf8'), 'console.log("zip probe")')
  assert.ok(fs.existsSync(path.join(target, 'plugin.json')))
})

test('互操作：Compress-Archive 打的包，我也能读出来（老用户手里的包不能失效）', () => {
  const theirs = path.join(SANDBOX, 'theirs.zip')
  fs.rmSync(theirs, { force: true })
  ps(`Compress-Archive -Path ${quote(path.join(SOURCE, 'plugin.json'))},${quote(path.join(SOURCE, 'dist'))},${quote(path.join(SOURCE, 'resources'))} -DestinationPath ${quote(theirs)} -Force`)
  assert.ok(fs.existsSync(theirs), 'Compress-Archive 应当生成了包')
  const names = readZipEntries(theirs).map(entry => entry.name.replace(/\\/g, '/')).sort()
  assert.ok(names.includes('plugin.json'), `读到的条目：${names.join(',')}`)
  assert.ok(names.includes('dist/app.js'), `读到的条目：${names.join(',')}`)
  const target = path.join(SANDBOX, 'theirs-extract')
  const written = extractZip(theirs, target)
  assert.ok(written.length >= 4, `应当解开至少 4 个文件，实际 ${written.length}`)
  assert.equal(fs.readFileSync(path.join(target, 'dist', 'app.js'), 'utf8'), 'console.log("zip probe")')
})

test('互操作：Compress-Archive 打的包名后缀是 .islandplugin 时也能读', () => {
  // 老包可能是用 .zip 生成的，也可能是 .islandplugin；读取不应依赖扩展名。
  const file = path.join(SANDBOX, 'legacy.islandplugin')
  fs.rmSync(file, { force: true })
  try {
    ps(`Compress-Archive -Path ${quote(path.join(SOURCE, 'plugin.json'))} -DestinationPath ${quote(file)} -Force`)
  } catch {
    // 有的 PowerShell 版本会拒绝非 .zip 扩展名（命令直接报错退出）—— 这恰恰是宿主要自己实现打包的原因。
  }
  if (!fs.existsSync(file)) {
    // 有的 PowerShell 版本会拒绝非 .zip 扩展名 —— 这恰恰是宿主要自己实现打包的原因。
    return
  }
  const names = readZipEntries(file).map(entry => entry.name)
  assert.ok(names.includes('plugin.json'), names.join(','))
})

console.log('=== 宿主 zip 实现验收 ===')
let failed = 0
for (const item of results) { if (!item.ok) failed += 1; console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `   [${item.detail}]` : ''}`) }
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)
