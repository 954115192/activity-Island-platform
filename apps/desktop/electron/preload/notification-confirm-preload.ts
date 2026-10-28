import { contextBridge, ipcRenderer } from 'electron'

/** 清空通知确认框专用桥：只回传用户选择，不暴露任何其它能力。 */
contextBridge.exposeInMainWorld('confirmDialog', {
  choose: (action: 'app-only' | 'both' | 'cancel'): void => {
    ipcRenderer.send('notifications:confirm-reply', action)
  },
})
