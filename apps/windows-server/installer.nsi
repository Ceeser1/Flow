; The Flow Server's installer for Windows. build.js stages the files and runs
; makensis with VERSION, STAGE (the staged folder), OUTFILE and ICON. The
; files go to Program Files\Flow Server; then setup.js asks how the server is
; to be set up, in a window of its own, and registers the task that starts it
; with Windows. An update keeps the setup and only restarts the server.

Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!include x64.nsh

!define APP "Flow Server"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"
!define SETUP '"$INSTDIR\node.exe" "$INSTDIR\app\windows\setup.js"'

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
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "${APP} is installed"
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
FunctionEnd

Function un.onInit
  SetRegView 64
FunctionEnd

Section "Flow Server"
  SetShellVarContext all

  ; An update: the server running from here stops first (node.exe is in use while it runs).
  ${If} ${FileExists} "$INSTDIR\app\windows\setup.js"
    DetailPrint "Stopping the Flow Server"
    nsExec::ExecToLog '${SETUP} stop'
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
  CreateShortcut "$SMPROGRAMS\${APP}\Uninstall Flow Server.lnk" "$INSTDIR\Uninstall Flow Server.exe"

  ; The questions (an update: none), the task, the firewall.
  DetailPrint "Setting up the Flow Server (in its own window)"
  ${If} ${Silent}
    ExecWait '${SETUP} --from-installer --yes' $0
  ${Else}
    ExecWait '${SETUP} --from-installer' $0
  ${EndIf}
  ${If} $0 != 0
    DetailPrint "The setup did not finish."
    ${IfNot} ${Silent}
      MessageBox MB_ICONEXCLAMATION "The Flow Server is installed, but its setup did not finish (its window said why). Run Flow Server Settings from the Start menu to try again."
    ${EndIf}
  ${EndIf}
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  DetailPrint "Removing the task and the firewall rules"
  nsExec::ExecToLog '${SETUP} --uninstall'
  Pop $0
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\tools"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\flow-server.cmd"
  Delete "$INSTDIR\icon.ico"
  Delete "$INSTDIR\Uninstall Flow Server.exe"
  RMDir "$INSTDIR"
  RMDir /r "$SMPROGRAMS\${APP}"
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  DeleteRegKey HKLM "Software\${APP}"
  DetailPrint "The library and the music stay where they are."
SectionEnd
