// 本地触发接口的访问令牌：首次生成后存入应用数据目录。
// 可加密时用 Electron safeStorage（Windows 上走 DPAPI），否则按明文保存并限制在用户目录内。
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage, app } from 'electron'

const TOKEN_BYTES = 24

export function loadOrCreateToken(filePath: string): string {
  // 开发期可用环境变量固定令牌，方便脚本与自动化验证；打包后一律使用安全存储的随机令牌。
  if (!app.isPackaged && process.env.ISLAND_NOTIFICATION_TOKEN) return process.env.ISLAND_NOTIFICATION_TOKEN
  mkdirSync(dirname(filePath), { recursive: true })
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf8').trim()
      if (raw.startsWith('enc:')) {
        if (!safeStorage.isEncryptionAvailable()) return '' // 换了用户/机器无法解密，交给调用方重新生成
        return safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'))
      }
      if (raw) return raw
    } catch {
      // 损坏则重新生成
    }
  }
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(token).toString('base64')
      writeFileSync(filePath, `enc:${encrypted}`, 'utf8')
    } else {
      writeFileSync(filePath, token, 'utf8')
      try {
        chmodSync(filePath, 0o600)
      } catch {
        // Windows 上 chmod 语义有限，失败不阻断
      }
    }
  } catch {
    // 写盘失败也不能阻断启动：本次运行使用内存令牌
  }
  return token
}

export function rotateToken(filePath: string): string {
  try {
    writeFileSync(filePath, '', 'utf8')
  } catch {
    // 忽略，随后重新生成
  }
  return loadOrCreateToken(filePath)
}
