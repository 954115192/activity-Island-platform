import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('dynamicIslandHost', {
  listPlugins: () => ipcRenderer.invoke('host:plugins:list'),
  getState: () => ipcRenderer.invoke('host:state:get'),
  onLayout: (listener: (layout: { mode: string; pluginMode?: 'small' | 'medium' | 'large'; separators: number[]; collapsed?: boolean; clipPlugins?: boolean; showClock?: boolean; contentWidth?: number; width: number; height: number; top: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, layout: { mode: string; pluginMode?: 'small' | 'medium' | 'large'; separators: number[]; collapsed?: boolean; clipPlugins?: boolean; showClock?: boolean; contentWidth?: number; width: number; height: number; top: number }) => listener(layout)
    ipcRenderer.on('host:layout', handler)
    return () => ipcRenderer.removeListener('host:layout', handler)
  },
  onAlert: (listener: (alert: { level: 'info' | 'warn' | 'critical'; color?: string | null } | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, alert: { level: 'info' | 'warn' | 'critical'; color?: string | null } | null) => listener(alert)
    ipcRenderer.on('host:alert', handler)
    return () => ipcRenderer.removeListener('host:alert', handler)
  },
  onPointerOutside: (listener: () => void) => { const handler = () => listener(); ipcRenderer.on('host:pointer-outside', handler); return () => ipcRenderer.removeListener('host:pointer-outside', handler) },
  onCursorInside: (listener: () => void) => { const handler = (_event: Electron.IpcRendererEvent, inside: boolean) => { if (inside) listener() }; ipcRenderer.on('host:cursor', handler); return () => ipcRenderer.removeListener('host:cursor', handler) },
  onPointerInside: (listener: () => void) => { const handler = (_event: Electron.IpcRendererEvent, inside: boolean) => { if (inside) listener() }; ipcRenderer.on('host:cursor', handler); return () => ipcRenderer.removeListener('host:cursor', handler) },
  onBlur: (listener: () => void) => { const handler = () => listener(); ipcRenderer.on('host:blur', handler); return () => ipcRenderer.removeListener('host:blur', handler) },
  sendAnimationFrame: (frame: { width: number; height: number; top: number; radius: number }) => ipcRenderer.send('host:animation-frame', frame),
  openSettings: (tab?: string) => ipcRenderer.invoke('console:open', 'settings', tab),
})
