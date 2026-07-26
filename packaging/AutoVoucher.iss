#define MyAppName "Auto Voucher"
#ifndef MyAppVersion
#define MyAppVersion "0.2.1"
#endif
#define MyAppPublisher "Auto Voucher Contributors"
#define MyAppExeName "AutoVoucherLauncher.exe"

[Setup]
AppId={{74402B27-20B6-4F79-B3C7-70BE6D39DB62}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\Auto Voucher
DefaultGroupName=Auto Voucher
PrivilegesRequired=lowest
OutputDir=..\release
OutputBaseFilename=AutoVoucher-Setup-{#MyAppVersion}-windows-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}

[Files]
Source: "..\release\AutoVoucherLauncher.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Auto Voucher"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\Auto Voucher"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式："

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 Auto Voucher"; Flags: nowait postinstall skipifsilent
