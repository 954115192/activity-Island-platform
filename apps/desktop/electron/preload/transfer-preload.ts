import { contextBridge, ipcRenderer } from 'electron'
import { installTransferDrop } from './transfer-drop'
import type { TransferSnapshot } from '../transfers/contracts'

installTransferDrop()
contextBridge.exposeInMainWorld('islandTransfer', {
  snapshot: () => ipcRenderer.invoke('transfers:call', 'snapshot'),
  call: (method: string, value?: unknown) => ipcRenderer.invoke('transfers:call', method, value),
  onChange: (listener: (value: TransferSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: TransferSnapshot) => listener(value)
    ipcRenderer.on('transfers:change', handler)
    return () => ipcRenderer.removeListener('transfers:change', handler)
  },
  onError: (listener: (message: string) => void) => {
    ipcRenderer.on('transfers:error', (_event, message) => listener(message))
  },
})
