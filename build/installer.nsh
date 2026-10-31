; Pitwall's additions to electron-builder's NSIS installer and uninstaller (electron-builder.yml: nsis.include).

; Is Pitwall running from the install folder: the app, or only its host (the same Pitwall.exe, run as Node), which
; keeps running after the app quits? With STOP 1, those processes are stopped first. RESULT: 0 when none is left, 2
; when some still run, anything else when PowerShell couldn't tell: "timeout" after a minute (a PowerShell that never
; exits was seen once, stuck in its own exit after the script had finished, so no run may hold the installer up).
;
; Every process whose executable is inside the install folder, matched by full path, case-insensitively, never by
; name: a Pitwall elsewhere (a dev build, another install) is never touched, nor is this installer itself (its
; parent). Stopped by pid, each one alone (no process tree). The folder reaches PowerShell in PITWALL_INSTDIR (set by
; customCheckAppRunning), never inside the command, so spaces, apostrophes and any other characters arrive as they
; are; and nothing is done unless Pitwall.exe is in it. `@(...)` counts one process as 1: electron-builder's own check
; reads `.Count` of a single process, which is empty on Windows PowerShell 5.1, so it missed a host running alone.
!macro PITWALL_PROCESSES STOP RESULT
  nsExec::Exec /TIMEOUT=60000 `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = 'Stop'; if (-not $$env:PITWALL_INSTDIR) { exit 3 }; $$d = $$env:PITWALL_INSTDIR.TrimEnd('\') + '\'; if (-not (Test-Path -LiteralPath ($$d + '${APP_EXECUTABLE_FILENAME}'))) { exit 0 }; $$me = (Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $$PID)).ParentProcessId; $$f = { @(Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ProcessId -ne $$me -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, 'OrdinalIgnoreCase') }) }; if (${STOP}) { & $$f | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; for ($$i = 0; $$i -lt 10; $$i++) { if (@(& $$f).Count -eq 0) { exit 0 }; Start-Sleep -Milliseconds 500 } }; if (@(& $$f).Count -gt 0) { exit 2 }; exit 0"`
  Pop ${RESULT}
!macroend

; Replaces electron-builder's running-app check, in the installer (a new install or an update over one) and in the
; uninstaller. Asks once (a silent run, /S, closes them without asking, so an update can go ahead); OK stops them,
; Cancel quits. Unless the stop then confirms that none is left: "close it manually", Retry or Cancel, as
; electron-builder does. A check that can't tell carries on (electron-builder would fall back to finding processes by
; name, which this never does: a Pitwall elsewhere must not be touched).
!macro customCheckAppRunning
  Push $0
  Push $R0
  ; The installer is 32-bit, so $SYSDIR's PowerShell is the 32-bit one. Emulated on ARM it took 5 to 45 s (and once
  ; never exited); the native one (Sysnative, seen only by 32-bit programs on 64-bit Windows) takes half a second.
  ; Both see every process.
  ${If} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    StrCpy $PowerShellPath "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  StrCpy $0 $INSTDIR
  System::Call 'kernel32::SetEnvironmentVariable(t "PITWALL_INSTDIR", t r0)'
  !insertmacro PITWALL_PROCESSES 0 $R0
  StrCmp $R0 2 pitwall_running
  StrCmp $R0 0 pitwall_done
  DetailPrint `Couldn't check whether ${PRODUCT_NAME} is running (PowerShell: $R0).`
  Goto pitwall_done
  pitwall_running:
    !ifdef BUILD_UNINSTALLER
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Pitwall or its background agents are running. Close them to continue?$\r$\n$\r$\nRunning agents stop." /SD IDOK IDOK pitwall_stop
    !else
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Pitwall or its background agents are running. Close them to continue?$\r$\n$\r$\nRunning agents stop and resume their conversations when you reopen Pitwall." /SD IDOK IDOK pitwall_stop
    !endif
    Quit
  pitwall_stop:
    DetailPrint "$(appClosing)"
    !insertmacro PITWALL_PROCESSES 1 $R0
    StrCmp $R0 0 pitwall_done
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY pitwall_stop
    Quit
  pitwall_done:
  ; Not passed on to what the installer starts next (the old uninstaller, the app it opens at the end).
  System::Call 'kernel32::SetEnvironmentVariable(t "PITWALL_INSTDIR", p 0)'
  Pop $R0
  Pop $0
!macroend

; Uninstall (not the old version's removal during an update): electron-builder keeps a copy of the installer in
; %LOCALAPPDATA%\pitwall-updater for electron-updater, which Pitwall doesn't use (about 125 MB). Delete that copy,
; then its folder if nothing else is in it.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    !ifdef APP_INSTALLER_STORE_FILE
      Push $R0
      ${If} $installMode == "all"
        SetShellVarContext current
      ${EndIf}
      Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
      ${StdUtils.GetParentPath} $R0 "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
      ${If} $R0 != ""
        RMDir "$R0"
      ${EndIf}
      ${If} $installMode == "all"
        SetShellVarContext all
      ${EndIf}
      Pop $R0
    !endif
  ${EndIf}
!macroend
