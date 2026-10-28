#!/usr/bin/env node
/**
 * 从模板生成一个新插件：
 *
 *   node scripts/new-plugin.mjs my-plugin "我的插件" [目标根目录]
 *
 * 目标根目录默认是仓库同级的 `island-plugin`（也就是开发目录），生成后到
 * 「控制台管理 → 插件 → 选择目录安装」装上，宿主会自动热重载后续改动。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [id, name, destRootArg] = process.argv.slice(2)
if (!id || !/^[a-z0-9_-]{1,64}$/.test(id)) {
  console.error('用法：node scripts/new-plugin.mjs <id> [名称] [目标根目录]')
  console.error('id 必须是 [a-z0-9_-]{1,64}（小写字母/数字/下划线/短横线）')
  process.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const template = path.join(here, 'templates', 'plugin')
const destRoot = path.resolve(destRootArg ?? path.join(here, '..', '..', 'island-plugin'))
const dest = path.join(destRoot, id)

if (!fs.existsSync(template)) { console.error(`找不到模板：${template}`); process.exit(1) }
if (fs.existsSync(dest)) { console.error(`目标已存在：${dest}`); process.exit(1) }

const displayName = name || id
fs.cpSync(template, dest, { recursive: true })
let replaced = 0
for (const file of walk(dest)) {
  if (!/\.(json|js|html|css|md|ps1)$/i.test(file)) continue
  const text = fs.readFileSync(file, 'utf8')
  if (!text.includes('__ID__') && !text.includes('__NAME__')) continue
  fs.writeFileSync(file, text.replaceAll('__ID__', id).replaceAll('__NAME__', displayName), 'utf8')
  replaced += 1
}

console.log(`已创建插件：${dest}`)
console.log(`  修改后到「控制台管理 → 插件 → 选择目录安装」装一次，之后改文件会自动热重载`)
console.log(`  打包：pwsh -File "${path.join(dest, 'pack.ps1')}"`)
console.log(`  （替换了 ${replaced} 个文件里的占位符）`)

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}
