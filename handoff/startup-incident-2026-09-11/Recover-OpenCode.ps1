# Incident-specific recovery. Default: read-only. No app launch/kill, no user-data edits.
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$incidentInstall = 'C:\Users\ylzho\AppData\Local\Programs\@opencode-aidesktop'
$incidentTarget = 'C:\Users\ylzho\AppData\Local\Programs\@opencode-aidesktop\resources\app.asar'
$incidentBackup = 'C:\Users\ylzho\AppData\Local\OpenCodeThemeSwitcher\instances\a67a928b01029b5c\backups\previous\previous-2026-09-11T02-15-40-576Z.asar'
$incidentExe = Join-Path $incidentInstall 'OpenCode.exe'
$incidentBrokenHash = 'eea58d3ab23733da12d9a9c0ebf8b807ee58f2b0dcadc2f2c2539a9473c28fe2'
$incidentRestoreHash = '1c53ca2472698a9e5ea1162ccb917a98b4e3f8d99ddd427b488dd063ddee6fc2'
$incidentExeHash = '577490460af80dcc84d48976556e548ade18f086d20dbb5946c7b335916f1b67'

function Get-IncidentHash([string]$LiteralFile) {
    return (Get-FileHash -LiteralPath $LiteralFile -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-IncidentFiles {
    foreach ($incidentFile in @($incidentTarget, $incidentBackup, $incidentExe)) {
        if (-not (Test-Path -LiteralPath $incidentFile -PathType Leaf)) {
            throw "Required file missing: $incidentFile"
        }
    }
    if ((Get-IncidentHash $incidentBackup) -ne $incidentRestoreHash) {
        throw 'Recovery backup hash mismatch. STOP; do not choose the newest backup instead.'
    }
    if ((Get-IncidentHash $incidentExe) -ne $incidentExeHash) {
        throw 'Executable changed since diagnosis. STOP; version compatibility must be reviewed.'
    }
    $incidentCurrentHash = Get-IncidentHash $incidentTarget
    if ($incidentCurrentHash -eq $incidentRestoreHash) { return 'already-restored' }
    if ($incidentCurrentHash -ne $incidentBrokenHash) {
        throw "Installation changed since diagnosis. Refusing overwrite. Current hash: $incidentCurrentHash"
    }
    return 'eligible'
}

function Assert-IncidentProcessesClosed {
    # Query failure or missing identity must not be treated as no process.
    $incidentProcesses = @(Get-CimInstance Win32_Process -Filter "Name='OpenCode.exe' OR Name='OpenCodeThemeSwitcher.exe' OR Name='electron.exe'" -ErrorAction Stop)
    foreach ($incidentProcess in $incidentProcesses) {
        $incidentProcessPath = [string]$incidentProcess.ExecutablePath
        $incidentCommand = [string]$incidentProcess.CommandLine
        $incidentBlocked = $false
        if ($incidentProcess.Name -ieq 'OpenCodeThemeSwitcher.exe') { $incidentBlocked = $true }
        elseif ($incidentProcess.Name -ieq 'OpenCode.exe') {
            $incidentBlocked = [string]::IsNullOrEmpty($incidentProcessPath) -or $incidentProcessPath.StartsWith($incidentInstall + '\', [StringComparison]::OrdinalIgnoreCase)
        }
        elseif ($incidentProcess.Name -ieq 'electron.exe') {
            $incidentBlocked = [string]::IsNullOrEmpty($incidentCommand) -or $incidentCommand -match '(?i)OpenCode_Theme_Switcher'
        }
        if ($incidentBlocked) {
            throw "Close the target application/error dialog and theme switcher first. PID=$($incidentProcess.ProcessId), Name=$($incidentProcess.Name). No process was terminated."
        }
    }
}

Write-Output "Target: $incidentTarget"
Write-Output "Recovery snapshot: $incidentBackup"
Write-Output 'This restores the earlier customized state, NOT factory defaults.'
Write-Warning 'This incident snapshot has a pre-existing OpenConsole.exe unpacked-header hash discrepancy. The external file is NOT changed by this script. GUI and terminal still require manual validation.'
$incidentState = Assert-IncidentFiles
if ($incidentState -eq 'already-restored') {
    Write-Output 'Already matches the selected recovery snapshot. No writes performed.'
    return
}

if (-not $Apply) {
    Write-Output 'READ-ONLY CHECK: target, executable and recovery snapshot hashes match the incident evidence.'
    try {
        Assert-IncidentProcessesClosed
        Write-Output 'Process check passed.'
    } catch {
        Write-Warning $_.Exception.Message
    }
    Write-Output 'No files changed. To recover after closing both apps, run this script with -Apply and confirm.'
    return
}

Assert-IncidentProcessesClosed
if (-not $PSCmdlet.ShouldProcess($incidentTarget, 'Restore the verified earlier snapshot; keep the current archive as an incident backup')) { return }

$incidentResourceDir = [IO.Path]::GetDirectoryName($incidentTarget)
$incidentDriveRoot = [IO.Path]::GetPathRoot($incidentResourceDir)
$incidentFreeBytes = ([IO.DriveInfo]::new($incidentDriveRoot)).AvailableFreeSpace
$incidentNeedBytes = (Get-Item -LiteralPath $incidentBackup).Length + (Get-Item -LiteralPath $incidentTarget).Length + 64MB
if ($incidentFreeBytes -lt $incidentNeedBytes) { throw 'Insufficient free space for safe recovery and incident preservation.' }

$incidentSuffix = [Guid]::NewGuid().ToString('N')
$incidentTemp = Join-Path $incidentResourceDir ('app.asar.recovery-' + $incidentSuffix + '.tmp')
$incidentPreserved = Join-Path $incidentResourceDir ('app.asar.failed-' + $incidentSuffix + '.bak')
foreach ($incidentFile in @($incidentTemp, $incidentPreserved)) {
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($incidentFile)) -ne [IO.Path]::GetFullPath($incidentResourceDir)) { throw 'Recovery path escaped the resource directory.' }
    if (Test-Path -LiteralPath $incidentFile) { throw "Refusing to overwrite an incident artifact: $incidentFile" }
}

try {
    [IO.File]::Copy($incidentBackup, $incidentTemp, $false)
    if ((Get-IncidentHash $incidentTemp) -ne $incidentRestoreHash) { throw 'Staged recovery copy failed hash verification.' }
    Assert-IncidentProcessesClosed
    if ((Assert-IncidentFiles) -ne 'eligible') { throw 'Target state changed during recovery preparation; no replacement attempted.' }

    # Same-directory replacement, preserving the prior target. No recursive delete or user-data writes.
    [IO.File]::Replace($incidentTemp, $incidentTarget, $incidentPreserved, $false)
    if ((Get-IncidentHash $incidentTarget) -ne $incidentRestoreHash) { throw 'Post-replacement hash mismatch. Stop; retain all incident files for manual recovery.' }
    if ((Get-IncidentHash $incidentPreserved) -ne $incidentBrokenHash) { throw 'Preserved incident archive hash mismatch. Stop and investigate.' }

    Write-Output 'RECOVERY FILE REPLACEMENT VERIFIED. No application was started.'
    Write-Output "Preserved broken archive: $incidentPreserved"
    Write-Output "Restored archive SHA256: $incidentRestoreHash"
    Write-Output 'Open OpenCode manually and verify startup, sessions and terminal. Do not apply another theme until the packer is fixed.'
    Write-Output 'Existing theme-switcher transaction records were deliberately left unchanged; the agent must record this manual recovery separately.'
} catch {
    Write-Warning "Recovery stopped. Preserved archive path (if replacement occurred): $incidentPreserved"
    Write-Warning "Staging path (if created): $incidentTemp"
    Write-Warning 'Do not retry blindly or delete these files. The script does not automatically roll back over an unexpected state.'
    throw
}
