import { EventEmitter } from 'node:events'

export class EventBus {
  private readonly emitter = new EventEmitter()

  emit<T = unknown>(name: string, payload: T): void { this.emitter.emit(name, payload) }

  on<T = unknown>(name: string, listener: (payload: T) => void): () => void {
    const fn = listener as (...args: unknown[]) => void
    this.emitter.on(name, fn)
    return () => this.emitter.off(name, fn)
  }

  clear(): void { this.emitter.removeAllListeners() }
}
