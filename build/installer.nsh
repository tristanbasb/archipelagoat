; Included by electron-builder's NSIS installer (electron-builder.yml, nsis.include).
;
; Uninstall: the archipelago:// handler and the .apsml2 association the app may have written for this
; account (spec §3.15, HKCU) go with it, when they still point at it: left behind, they would send the
; links and the patches to a program that no longer exists, and HKCU wins over Archipelago's own HKLM
; registration. An update runs the old uninstaller too: the keys stay then, the new copy uses them.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    StrCpy $1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    ReadRegStr $0 HKCU "Software\Classes\archipelago\shell\open\command" ""
    ${if} $0 == $1
      DeleteRegKey HKCU "Software\Classes\archipelago"
    ${endIf}
    ReadRegStr $0 HKCU "Software\Classes\.apsml2" ""
    ${if} $0 == "ArchipelaGOAT.Patch"
      DeleteRegValue HKCU "Software\Classes\.apsml2" ""
    ${endIf}
    DeleteRegKey HKCU "Software\Classes\ArchipelaGOAT.Patch"
  ${endIf}
!macroend
