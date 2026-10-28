// 同步自 packages/platform-services/src/notification/sources/local-trigger-node.ts（双向同步）
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { LocalHttpRequest, LocalHttpResponse, LocalHttpTransport } from './local-trigger'

const HARD_BODY_LIMIT = 1024 * 1024

/** Node 实现的本地 HTTP 传输：仅绑定注入的主机地址，默认回环 */
export class NodeHttpTransport implements LocalHttpTransport {
  private server: Server | undefined
  private handler: ((request: LocalHttpRequest) => Promise<LocalHttpResponse>) | undefined

  async listen(options: { host: string; port: number }): Promise<{ actualPort: number }> {
    const server = createServer((request, response) => {
      void this.dispatch(request, response)
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onError = (cause: Error): void => reject(cause)
      server.once('error', onError)
      server.listen(options.port, options.host, () => {
        server.off('error', onError)
        server.on('error', () => {})
        resolve()
      })
    })
    const address = server.address()
    return { actualPort: typeof address === 'object' && address ? address.port : options.port }
  }

  onRequest(handler: (request: LocalHttpRequest) => Promise<LocalHttpResponse>): void {
    this.handler = handler
  }

  async close(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const collected = await this.collect(request, response)
      if (!collected) return
      const handled = this.handler
        ? await this.handler(collected)
        : { status: 503, body: '{"ok":false,"error":{"code":"unavailable","message":"处理未就绪","retryable":true}}' }
      this.reply(response, handled)
    } catch {
      this.reply(response, {
        status: 500,
        body: '{"ok":false,"error":{"code":"internal","message":"处理请求失败","retryable":false}}',
      })
    }
  }

  private collect(request: IncomingMessage, response: ServerResponse): Promise<LocalHttpRequest | undefined> {
    return new Promise((resolve, reject) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const declared = Number(request.headers['content-length'] ?? 0)
      if (declared > HARD_BODY_LIMIT) {
        response.statusCode = 413
        response.end()
        request.resume()
        resolve(undefined)
        return
      }

      const chunks: Buffer[] = []
      let size = 0
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > HARD_BODY_LIMIT) {
          response.statusCode = 413
          response.end()
          request.destroy()
          resolve(undefined)
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        resolve({
          method: request.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          headers: request.headers,
          body: Buffer.concat(chunks),
          remoteAddress: normalizeRemoteAddress(request.socket?.remoteAddress),
        })
      })
      request.on('error', reject)
    })
  }

  private reply(response: ServerResponse, result: LocalHttpResponse): void {
    response.statusCode = result.status
    if (result.headers) {
      for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value)
    }
    response.end(result.body ?? '')
  }
}

/** IPv4 映射地址形如 ::ffff:192.168.1.5，统一成纯 IPv4 便于限速与日志 */
function normalizeRemoteAddress(address: string | undefined): string | undefined {
  if (!address) return undefined
  return address.startsWith('::ffff:') ? address.slice(7) : address
}
