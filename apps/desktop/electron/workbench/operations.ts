import { clampNumber } from '../shared/numbers'
import { shell } from 'electron'
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const WORKBENCH_HTTP_MAX_BYTES = 2 * 1024 * 1024
/** run 的 stdout/stderr 各自上限。 */
const WORKBENCH_RUN_MAX_BYTES = 256 * 1024

/**
 * 打开网址 / 程序 / 文件 / 文件夹。
 *
 * 以前这里只调 `shell.openPath` 并**忽略返回值、恒返回 `{ok:true}`**，于是：
 * 填一个网址 → 界面显示 🔗 → 点了没反应 → 还提示成功（`openPath` 开不了网址，要 `openExternal`）。
 * 现在按 scheme 分流，并且把失败如实报上来。
 */
export async function workbenchOpen(target: string): Promise<{ ok: boolean; kind?: 'url' | 'path'; error?: string }> {
  const raw = String(target ?? '').trim()
  if (!raw) return { ok: false, error: '没有要打开的目标' }
  if (/^https?:\/\//i.test(raw) || /^mailto:/i.test(raw)) {
    try {
      await shell.openExternal(raw)
      return { ok: true, kind: 'url' }
    } catch (error) {
      return { ok: false, error: `打开网址失败：${String((error as Error)?.message ?? error)}` }
    }
  }
  // shell.openPath 失败时**返回错误字符串**而不是抛异常，必须自己看返回值。
  const failure = await shell.openPath(raw)
  if (failure) return { ok: false, error: failure, kind: 'path' }
  return { ok: true, kind: 'path' }
}

/** 通用网络请求：主进程发出，不受 CORS 限制，因此也能访问 127.0.0.1 上的本地服务。 */
export async function workbenchHttp(url: string, options: { method?: unknown; headers?: unknown; body?: unknown; timeoutMs?: unknown } = {}): Promise<Record<string, unknown>> {
  let parsed: URL
  try { parsed = new URL(String(url ?? '')) } catch { return { ok: false, error: `不是合法的网址：${String(url ?? '')}` } }
  // 只允许 http/https：挡掉 file:// 之类经由 fetch 的意外读取。
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: `只允许 http/https（收到 ${parsed.protocol}）` }
  const timeoutMs = clampNumber(options.timeoutMs, 1000, 120000, 15000)
  const method = typeof options.method === 'string' && options.method.trim() ? options.method.trim().toUpperCase() : 'GET'
  const headers = options.headers && typeof options.headers === 'object' ? options.headers as Record<string, string> : undefined
  const body = typeof options.body === 'string' ? options.body : undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  try {
    const response = await fetch(parsed, { method, headers, body, signal: controller.signal })
    const chunks: Buffer[] = []
    let length = 0
    let truncated = false
    const reader = response.body?.getReader()
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const remaining = WORKBENCH_HTTP_MAX_BYTES - length
          chunks.push(Buffer.from(value.subarray(0, remaining)))
          length += Math.min(value.length, remaining)
          if (value.length > remaining) {
            truncated = true
            await reader.cancel()
            break
          }
        }
      } finally { reader.releaseLock() }
    }
    const raw = Buffer.concat(chunks, length)
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: raw.subarray(0, WORKBENCH_HTTP_MAX_BYTES).toString('utf8'),
      truncated,
      ms: Date.now() - startedAt,
    }
  } catch (error) {
    const reason = (error as Error)?.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : String((error as Error)?.message ?? error)
    return { ok: false, error: reason, ms: Date.now() - startedAt }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 执行本机命令 / 脚本。默认**不经 shell**（`shell: true` 要显式开），
 * 避免把用户填的内容当成 shell 语法解释。
 */
export async function workbenchRun(command: string, args: string[] = [], options: { cwd?: unknown; timeoutMs?: unknown; shell?: unknown } = {}): Promise<Record<string, unknown>> {
  const line = String(command ?? '').trim()
  if (!line) return { ok: false, error: '没有要执行的命令' }
  const timeoutMs = clampNumber(options.timeoutMs, 1000, 600000, 60000)
  const cwd = typeof options.cwd === 'string' && options.cwd && fs.existsSync(options.cwd) ? options.cwd : undefined
  const useShell = options.shell === true
  const safeArgs = Array.isArray(args) ? args.map(value => String(value)) : []
  return await new Promise<Record<string, unknown>>(resolve => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (payload: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(payload)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(line, safeArgs, { cwd, windowsHide: true, shell: useShell, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, error: String((error as Error)?.message ?? error), code: null, stdout: '', stderr: '' })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 忽略 */ }
      finish({ ok: false, error: `执行超时（${timeoutMs}ms）`, code: null, stdout: stdout.slice(0, WORKBENCH_RUN_MAX_BYTES), stderr: stderr.slice(0, WORKBENCH_RUN_MAX_BYTES) })
    }, timeoutMs)
    child.stdout?.on('data', chunk => { if (stdout.length < WORKBENCH_RUN_MAX_BYTES) stdout += String(chunk) })
    child.stderr?.on('data', chunk => { if (stderr.length < WORKBENCH_RUN_MAX_BYTES) stderr += String(chunk) })
    child.on('error', error => finish({ ok: false, error: String((error as Error)?.message ?? error), code: null, stdout: '', stderr: '' }))
    child.on('close', code => finish({ ok: code === 0, code, stdout: stdout.slice(0, WORKBENCH_RUN_MAX_BYTES), stderr: stderr.slice(0, WORKBENCH_RUN_MAX_BYTES) }))
  })
}

