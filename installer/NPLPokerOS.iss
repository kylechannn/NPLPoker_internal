; NPL Poker OS -- Inno Setup 6 installer.
;
; Compile via installer\build-installer.ps1, which assembles installer\payload\
; first. The payload mirrors the runtime layout the Go host expects beside the
; executable (see backend_app.go / main.go):
;
;   payload\NPLPokerOS.exe                 the Go host (UI embedded via go:embed)
;   payload\Caddyfile                      gateway config; host creates logs\ beside it
;   payload\ConfigureStaffGateway.ps1      staff-gateway firewall helper
;   payload\redist\caddy\caddy.exe         findCaddy() checks redist\caddy first
;   payload\.tools\php\...                 backendPHPBinary() checks .tools\php\php.exe first
;   payload\app\npl_internal\...           bundled Laravel backend (vendor\ included,
;                                          fresh .env + APP_KEY, pre-migrated
;                                          database\database.sqlite)
;
; Compression: lzma2/max + solid. The mahjong installer used `store`, but only
; because its payload was an already-Inno-compressed engine inside an Electron
; portable wrapper that re-extracted at every launch. This is a plain Inno
; installer that runs once, so maximum compression is the right trade.

#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif

#define MyAppName "NPL Poker OS"
#define MyAppExeName "NPLPokerOS.exe"
#define MyAppPublisher "NPL Poker"
#define IconFile AddBackslash(SourcePath) + "app.ico"

[Setup]
; Never change the AppId: upgrades in place depend on it.
AppId={{6E2B9C41-5D8A-4F37-B1E6-9A0C4D7F2B58}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\NPL Poker OS
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
OutputBaseFilename=NPLPokerOS-Setup-{#MyAppVersion}
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
CloseApplications=force
SetupLogging=yes
#if FileExists(IconFile)
SetupIconFile={#IconFile}
#endif

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Dirs]
; The app writes into its own directory at runtime (SQLite, Laravel storage,
; Caddy logs, manual-update staging), and it runs unelevated -- so under
; Program Files the install root must be user-writable.
Name: "{app}"; Permissions: users-modify
; Runtime directories: created up front, never removed at uninstall.
Name: "{app}\logs"; Flags: uninsneveruninstall
Name: "{app}\app\npl_internal\database"; Flags: uninsneveruninstall
Name: "{app}\app\npl_internal\bootstrap\cache"; Flags: uninsneveruninstall
Name: "{app}\app\npl_internal\storage\app"; Flags: uninsneveruninstall
Name: "{app}\app\npl_internal\storage\logs"; Flags: uninsneveruninstall
Name: "{app}\app\npl_internal\storage\framework\cache"; Flags: uninsneveruninstall
Name: "{app}\app\npl_internal\storage\framework\sessions"; Flags: uninsneveruninstall
Name: "{app}\app\npl_internal\storage\framework\views"; Flags: uninsneveruninstall

[Files]
; Program files -- always refreshed on upgrade. User data is excluded here and
; shipped by the guarded entries below.
Source: "payload\*"; DestDir: "{app}"; \
  Excludes: "\app\npl_internal\.env,\app\npl_internal\database\*.sqlite*,\app\npl_internal\storage\*,*.log"; \
  Flags: recursesubdirs createallsubdirs ignoreversion sortfilesbyextension

; User data -- installed once, never overwritten on upgrade, never uninstalled.
Source: "payload\app\npl_internal\.env"; DestDir: "{app}\app\npl_internal"; \
  Flags: onlyifdoesntexist uninsneveruninstall
Source: "payload\app\npl_internal\database\database.sqlite"; DestDir: "{app}\app\npl_internal\database"; \
  Flags: onlyifdoesntexist uninsneveruninstall
Source: "payload\app\npl_internal\storage\*"; DestDir: "{app}\app\npl_internal\storage"; \
  Flags: recursesubdirs createallsubdirs onlyifdoesntexist uninsneveruninstall

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; \
  Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM {#MyAppExeName}"; \
  Flags: runhidden; RunOnceId: "KillHost"
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Get-Process php,caddy -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -like '{app}\*' } | Stop-Process -Force"""; \
  Flags: runhidden; RunOnceId: "KillChildren"

[Code]
{ ---- Status bridge -------------------------------------------------------
  The modern Electron shell runs this engine /VERYSILENT and passes
  /STATUSFILE=<path>; every state change is written there as one JSON
  object of state, progress and message for the shell to poll. Without
  the parameter (the classic double-click install) the bridge is inert. }
var
  StatusFilePath: String;
  LastReportedPercent: Integer;

function JsonEscape(const Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '"', '\"', True);
  StringChangeEx(Result, #13#10, '\n', True);
  StringChangeEx(Result, #13, '\n', True);
  StringChangeEx(Result, #10, '\n', True);
end;

procedure WriteInstallerStatus(const State: String; Progress: Integer; const MessageText: String);
begin
  if StatusFilePath = '' then
    exit;

  if Progress < 0 then
    Progress := 0;
  if Progress > 100 then
    Progress := 100;

  SaveStringToFile(StatusFilePath,
    '{"state":"' + JsonEscape(State) + '","progress":' + IntToStr(Progress) +
    ',"message":"' + JsonEscape(MessageText) + '"}', false);
end;

function InitializeSetup(): Boolean;
begin
  StatusFilePath := ExpandConstant('{param:STATUSFILE|}');
  LastReportedPercent := -1;
  WriteInstallerStatus('starting', 5, 'Opening the NPL Poker OS installation engine…');
  Result := True;
end;

procedure CurInstallProgressChanged(CurProgress, MaxProgress: Integer);
var
  Percent: Integer;
begin
  if (StatusFilePath = '') or (MaxProgress <= 0) then
    exit;

  { File copy occupies 10..85 of the visible bar; only write on change. }
  Percent := 10 + (CurProgress * 75) div MaxProgress;
  if Percent <> LastReportedPercent then
  begin
    LastReportedPercent := Percent;
    WriteInstallerStatus('installing', Percent, 'Copying verified NPL Poker OS files…');
  end;
end;

procedure KillRunningInstances;
var
  ResultCode: Integer;
  AppDir: String;
begin
  { The host owns php.exe / caddy.exe children through a job object, but a }
  { crashed host can leave them behind -- kill by name, then sweep any php / }
  { caddy whose binary lives under the install directory. }
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM NPLPokerOS.exe',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  AppDir := ExpandConstant('{app}');
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command "Get-Process php,caddy -ErrorAction SilentlyContinue ' +
    '| Where-Object { $_.Path -like ''' + AppDir + '\*'' } | Stop-Process -Force"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  { Give Windows a moment to release file locks before copying begins. }
  Sleep(1500);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  WriteInstallerStatus('preparing', 8, 'Closing any running NPL Poker OS…');
  KillRunningInstances;
  Result := '';
end;

procedure CheckInstalledFile(const RelativePath: String; var Missing: String);
begin
  if not FileExists(ExpandConstant('{app}\' + RelativePath)) then
    Missing := Missing + #13#10 + '    ' + RelativePath;
end;

procedure VerifyInstalledPayload;
var
  Missing: String;
begin
  { Belt and braces against a truncated or corrupted installer (the mahjong }
  { installer once shipped a half-written payload): confirm every critical }
  { runtime file actually landed on disk. }
  Missing := '';
  CheckInstalledFile('NPLPokerOS.exe', Missing);
  CheckInstalledFile('Caddyfile', Missing);
  CheckInstalledFile('redist\caddy\caddy.exe', Missing);
  CheckInstalledFile('.tools\php\php.exe', Missing);
  CheckInstalledFile('.tools\php\php.ini', Missing);
  CheckInstalledFile('app\npl_internal\artisan', Missing);
  CheckInstalledFile('app\npl_internal\vendor\autoload.php', Missing);
  CheckInstalledFile('app\npl_internal\.env', Missing);
  CheckInstalledFile('app\npl_internal\database\database.sqlite', Missing);

  if Missing <> '' then
  begin
    WriteInstallerStatus('failed', 96,
      'This installation is incomplete — required files are missing. '
      + 'The installer file is likely truncated; re-copy it, verify its SHA256, and run it again.');
    MsgBox('This installation is incomplete -- the following required files are missing:'
      + #13#10 + Missing + #13#10 + #13#10
      + 'The installer file is likely truncated or corrupted. Re-copy it and verify '
      + 'its SHA256 hash against the one printed by the build '
      + '(certutil -hashfile <setup exe> SHA256), then run it again.',
      mbCriticalError, MB_OK);
    Abort;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WriteInstallerStatus('configuring', 90, 'Verifying every installed file…');
    VerifyInstalledPayload;
  end;

  if CurStep = ssDone then
    WriteInstallerStatus('completed', 100, 'NPL Poker OS is installed and ready.');
end;
