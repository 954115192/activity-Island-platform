; Activity Island 自定义 NSIS 卸载钩子（electron-builder 自动包含本文件）。
;
; 默认卸载保留用户数据（deleteAppDataOnUninstall: false）：插件、工作台、参数、日志
; 都在 %APPDATA%\dynamic-island-host，重装后继续可用。这里在卸载完程序后追加一次
; 询问，让愿意"删干净"的用户当场删掉，不用自己去翻 AppData。
!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除插件与工作台数据？$\n$\n「是」：删除 %APPDATA%\dynamic-island-host（已安装的插件、工作台、参数与日志，不可恢复）$\n「否」：保留数据，重新安装后插件还在" IDYES island_delete_data
  Goto island_skip_data
island_delete_data:
  RMDir /r "$APPDATA\dynamic-island-host"
island_skip_data:
!macroend
