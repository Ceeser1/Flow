; The Flow Server's installer for Windows. build.js stages the files and runs
; makensis with VERSION, STAGE (the staged folder), OUTFILE and ICON. The
; files go to Program Files\Flow Server; then setup.js asks how the server is
; to be set up, in a window of its own, and registers the task that starts it
; with Windows. Over an installed one it first offers Only update (the setup
; stays, the server restarts), Reinstall (the questions again, Enter keeping
; each answer) and Uninstall.

Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!include x64.nsh
!include nsDialogs.nsh

!define APP "Flow Server"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"
!define SETUP '"$INSTDIR\node.exe" "$INSTDIR\app\windows\setup.js"'
!define TRAY "Flow Server Tray.exe"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

Name "${APP}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\${APP}"
InstallDirRegKey HKLM "Software\${APP}" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
BrandingText "${APP} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "${APP} ${VERSION} Setup"
VIAddVersionKey "CompanyName" "Ceeser"
VIAddVersionKey "LegalCopyright" "MIT License"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "${APP} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "The Flow Server keeps your music library on this PC and streams it to the Flow apps on your phone and other computers.$\r$\n$\r$\nAfter copying its files, a window asks how far the server should be reachable (home network, Tailscale, or the internet through your own web server), where the music folder is, and a few more things. The server then starts with Windows, before anyone signs in.$\r$\n$\r$\nInstall it from the Windows account it should run as."
; 0 a new install, 1 only update, 2 reinstall (change config)
Var Mode
Var RadioUpdate
Var RadioReinstall
Var RadioUninstall

!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipWhenInstalled
!insertmacro MUI_PAGE_WELCOME
Page custom ModePage ModeLeave
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipWhenInstalled
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "${APP} is ready"
!define MUI_FINISHPAGE_TEXT "Flow Server Settings in the Start menu changes how it is set up. Start, Stop and Restart Flow Server, its log and its command line are there too."
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "The Flow Server needs 64-bit Windows."
    Abort
  ${EndIf}
  SetRegView 64
  ReadRegStr $0 HKLM "Software\${APP}" "InstallDir"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
  StrCpy $Mode 0
  ${If} ${FileExists} "$INSTDIR\app\windows\setup.js"
    StrCpy $Mode 1
  ${EndIf}
FunctionEnd

; Installed already: no welcome, and the folder stays where it is.
Function SkipWhenInstalled
  ${If} $Mode != 0
    Abort
  ${EndIf}
FunctionEnd

Function ModePage
  ${If} $Mode == 0
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "${APP} is installed already" "What should happen with the Flow Server in $INSTDIR?"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateRadioButton} 0 0 100% 12u "Only update"
  Pop $RadioUpdate
  ${NSD_CreateLabel} 12u 13u -12u 20u "Everything stays as it is set up. The server is updated and restarted."
  Pop $0
  ${NSD_CreateRadioButton} 0 38u 100% 12u "Reinstall (change config)"
  Pop $RadioReinstall
  ${NSD_CreateLabel} 12u 51u -12u 20u "The setup questions again, in a window of their own. Enter keeps each answer as it is."
  Pop $0
  ${NSD_CreateRadioButton} 0 76u 100% 12u "Uninstall"
  Pop $RadioUninstall
  ${NSD_CreateLabel} 12u 89u -12u 20u "Removes the server, its task and its firewall rules. The library and the music stay."
  Pop $0
  ${If} $Mode == 2
    ${NSD_Check} $RadioReinstall
  ${Else}
    ${NSD_Check} $RadioUpdate
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function ModeLeave
  ${NSD_GetState} $RadioUninstall $0
  ${If} $0 == ${BST_CHECKED}
    HideWindow
    ExecWait '"$INSTDIR\Uninstall Flow Server.exe" _?=$INSTDIR' $1
    ${If} $1 == 0
      Delete "$INSTDIR\Uninstall Flow Server.exe"
      RMDir "$INSTDIR"
    ${EndIf}
    Quit
  ${EndIf}
  ${NSD_GetState} $RadioReinstall $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Mode 2
  ${Else}
    StrCpy $Mode 1
  ${EndIf}
FunctionEnd

Function un.onInit
  SetRegView 64
FunctionEnd

Section "Flow Server"
  SetShellVarContext all

  ; An update: the server running from here stops first (node.exe is in use while it runs),
  ; and so does the tray icon (its exe).
  ${If} ${FileExists} "$INSTDIR\app\windows\setup.js"
    DetailPrint "Stopping the Flow Server"
    nsExec::ExecToLog '${SETUP} stop'
    Pop $0
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\${TRAY}"
    nsExec::Exec '"$INSTDIR\${TRAY}" --quit'
    Pop $0
  ${EndIf}

  RMDir /r "$INSTDIR\app"
  SetOutPath "$INSTDIR\app"
  File /r "${STAGE}\app\*.*"
  SetOutPath "$INSTDIR\tools"
  File /nonfatal "${STAGE}\tools\*.*"
  SetOutPath "$INSTDIR"
  File "${STAGE}\node.exe"
  File "${STAGE}\flow-server.cmd"
  File "${STAGE}\icon.ico"
  File "${STAGE}\${TRAY}"
  WriteUninstaller "$INSTDIR\Uninstall Flow Server.exe"

  WriteRegStr HKLM "Software\${APP}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "Ceeser"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall Flow Server.exe"'
  WriteRegStr HKLM "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall Flow Server.exe" /S'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1

  RMDir /r "$SMPROGRAMS\${APP}"
  CreateDirectory "$SMPROGRAMS\${APP}"
  CreateShortcut "$SMPROGRAMS\${APP}\Flow Server Settings.lnk" "$INSTDIR\node.exe" '"$INSTDIR\app\windows\setup.js" --pause' "$INSTDIR\icon.ico"
  CreateShortcut "$SMPROGRAMS\${APP}\Start Flow Server.lnk" "$INSTDIR\node.exe" '"$INSTDIR\app\windows\setup.js" start --pause' "$INSTDIR\icon.ico"
  CreateShortcut "$SMPROGRAMS\${APP}\Stop Flow Server.lnk" "$INSTDIR\node.exe" '"$INSTDIR\app\windows\setup.js" stop --pause' "$INSTDIR\icon.ico"
  CreateShortcut "$SMPROGRAMS\${APP}\Restart Flow Server.lnk" "$INSTDIR\node.exe" '"$INSTDIR\app\windows\setup.js" restart --pause' "$INSTDIR\icon.ico"
  CreateShortcut "$SMPROGRAMS\${APP}\Flow Server Log.lnk" "$INSTDIR\node.exe" '"$INSTDIR\app\windows\setup.js" log' "$INSTDIR\icon.ico" 0 SW_SHOWMINIMIZED
  CreateShortcut "$SMPROGRAMS\${APP}\Flow Server Command Line.lnk" "$SYSDIR\cmd.exe" '/k "$INSTDIR\flow-server.cmd" --help' "$INSTDIR\icon.ico"
  CreateShortcut "$SMPROGRAMS\${APP}\Flow Server Tray Icon.lnk" "$INSTDIR\${TRAY}"
  CreateShortcut "$SMPROGRAMS\${APP}\Uninstall Flow Server.lnk" "$INSTDIR\Uninstall Flow Server.exe"
  ; The tray icon at every sign-in of this user (the account the server runs as).
  WriteRegStr HKCU "${RUN_KEY}" "Flow Server Tray" '"$INSTDIR\${TRAY}"'

  ; The questions (an update: none), the task, the firewall.
  DetailPrint "Setting up the Flow Server (in its own window)"
  ${If} ${Silent}
    ExecWait '${SETUP} --from-installer --yes' $0
  ${Else}
    ${If} $Mode == 1
      ExecWait '${SETUP} --from-installer --only-update' $0
    ${Else}
      ExecWait '${SETUP} --from-installer' $0
    ${EndIf}
  ${EndIf}
  ${If} $0 != 0
    DetailPrint "The setup did not finish."
    ${IfNot} ${Silent}
      MessageBox MB_ICONEXCLAMATION "The Flow Server is installed, but its setup did not finish (its window said why). Run Flow Server Settings from the Start menu to try again."
    ${EndIf}
  ${EndIf}
  ; The tray icon now too, through Explorer so it runs as the user and not as the administrator this installer is.
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\${TRAY}"'
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  DetailPrint "Removing the task and the firewall rules"
  nsExec::ExecToLog '${SETUP} --uninstall'
  Pop $0
  nsExec::Exec '"$INSTDIR\${TRAY}" --quit'
  Pop $0
  DeleteRegValue HKCU "${RUN_KEY}" "Flow Server Tray"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\tools"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\flow-server.cmd"
  Delete "$INSTDIR\icon.ico"
  Delete "$INSTDIR\${TRAY}"
  Delete "$INSTDIR\Uninstall Flow Server.exe"
  RMDir "$INSTDIR"
  RMDir /r "$SMPROGRAMS\${APP}"
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  DeleteRegKey HKLM "Software\${APP}"
  DetailPrint "The library and the music stay where they are."
SectionEnd
