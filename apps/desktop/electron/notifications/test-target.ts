// 说明页「端口发送」的目标地址解析：纯逻辑，不依赖 Electron，便于单独测试。

export interface TestTarget {
  host: string
  port: number
  path: string
}

export type TestTargetResult = ({ ok: true } & TestTarget) | { ok: false; error: string }

const API_PATH = '/api/v1/notifications'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 5720

/**
 * 支持三种写法：
 *   1.2.3.4                  → 用当前配置的端口
 *   1.2.3.4:5720             → 指定端口
 *   http://1.2.3.4:5720/xxx  → 完整 URL
 * 留空则回落到当前配置的端点，方便一键测本机。
 */
export function parseTestTarget(raw: unknown, fallbackEndpoint: string | null): TestTargetResult {
  const text = typeof raw === 'string' ? raw.trim() : ''

  let fallbackHost = DEFAULT_HOST
  let fallbackPort = DEFAULT_PORT
  if (fallbackEndpoint) {
    try {
      const url = new URL(fallbackEndpoint)
      fallbackHost = url.hostname
      fallbackPort = Number(url.port || 80)
    } catch {
      // 端点异常时用默认值
    }
  }

  if (!text) return { ok: true, host: fallbackHost, port: fallbackPort, path: API_PATH }

  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      return {
        ok: true,
        host: url.hostname,
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
        path: url.pathname && url.pathname !== '/' ? url.pathname : API_PATH,
      }
    } catch {
      return { ok: false, error: '目标地址格式不正确' }
    }
  }

  // 裸地址：IPv6 需要方括号，形如 [::1]:5720
  const match = /^([A-Za-z0-9.:\-[\]]+?)(?::(\d{1,5}))?$/.exec(text)
  if (!match) return { ok: false, error: '目标地址格式不正确，示例：192.168.1.3 或 192.168.1.3:5720' }
  const host = match[1].replace(/^\[|\]$/g, '')
  if (!host) return { ok: false, error: '目标地址缺少主机' }
  const port = match[2] ? Number(match[2]) : fallbackPort
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: '端口应在 1–65535 之间' }
  return { ok: true, host, port, path: API_PATH }
}
