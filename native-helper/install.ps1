param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$installDirectory = Join-Path $env:LOCALAPPDATA 'TabDownloaderAMediaHelper'
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'TabDownloaderAMediaHelper'

function Stop-HelperAtDirectory([string]$Directory) {
    $pidPath = Join-Path $Directory 'helper.pid'
    if (-not (Test-Path -LiteralPath $pidPath)) { return }
    $helperPid = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$helperPid)) { return }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $helperPid" -ErrorAction SilentlyContinue
    $expectedServer = Join-Path $Directory 'server.cjs'
    if ($process -and $process.Name -eq 'node.exe' -and $process.CommandLine -like "*$expectedServer*") {
        Stop-Process -Id $helperPid -Force
    }
}

function Remove-HelperLogonTask {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
}

if ($Uninstall) {
    Remove-HelperLogonTask
    Stop-HelperAtDirectory $installDirectory
    if (Test-Path -LiteralPath $installDirectory) { Remove-Item -LiteralPath $installDirectory -Recurse -Force }
    Write-Output 'Media Helper를 제거했습니다.'
    exit 0
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$ytDlp = (Get-Command yt-dlp.exe -ErrorAction Stop).Source
$ffmpeg = if ($env:TAB_DOWNLOADER_A_FFMPEG) { $env:TAB_DOWNLOADER_A_FFMPEG } else { (Get-Command ffmpeg.exe -ErrorAction Stop).Source }
$converterPath = Join-Path $projectDirectory 'image-converter.cjs'
$selectedFfmpeg = & $nodePath -e 'try { console.log(require(process.argv[1]).selectWebpFfmpeg(process.argv[2])); } catch (error) { console.error(error.message); process.exit(1); }' $converterPath $ffmpeg
if ($LASTEXITCODE -ne 0) { throw 'WebP 지원 FFmpeg 확인 실패. 기존 Helper는 변경하지 않았습니다.' }
$ffmpeg = $selectedFfmpeg.Trim()

Stop-HelperAtDirectory $installDirectory
New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectDirectory 'server.cjs') -Destination (Join-Path $installDirectory 'server.cjs') -Force
Copy-Item -LiteralPath (Join-Path $projectDirectory 'platform.cjs') -Destination (Join-Path $installDirectory 'platform.cjs') -Force
Copy-Item -LiteralPath (Join-Path $projectDirectory 'image-policy.cjs') -Destination (Join-Path $installDirectory 'image-policy.cjs') -Force
Copy-Item -LiteralPath (Join-Path $projectDirectory 'image-converter.cjs') -Destination (Join-Path $installDirectory 'image-converter.cjs') -Force
Copy-Item -LiteralPath (Join-Path $projectDirectory 'youtube-transcripts.cjs') -Destination (Join-Path $installDirectory 'youtube-transcripts.cjs') -Force

$config = @{
    extensionId = $ExtensionId
    port = 17385
    nodePath = $nodePath
    ytDlpPath = $ytDlp
    ffmpegPath = $ffmpeg
} | ConvertTo-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $installDirectory 'helper-config.json'), $config, $utf8NoBom)


# macOS의 LaunchAgent와 같은 역할. 로그온할 때마다 Helper를 자동으로 띄운다.
try {
    Remove-HelperLogonTask
    $serverPath = Join-Path $installDirectory 'server.cjs'
    $configPath = Join-Path $installDirectory 'helper-config.json'
    # node.exe를 작업으로 직접 실행하면 로그온할 때 콘솔 창이 떠서 닫히지 않는다.
    # 관리자 권한 없이 창을 숨기려면 wscript로 감싸 실행한다(ASCII 전용 스크립트).
    $launcherPath = Join-Path $installDirectory 'start-hidden.vbs'
    $launcher = 'CreateObject("WScript.Shell").Run """{0}"" ""{1}"" ""{2}""", 0, False' -f $nodePath, $serverPath, $configPath
    [System.IO.File]::WriteAllText($launcherPath, $launcher, [System.Text.Encoding]::ASCII)
    Register-ScheduledTask -TaskName $taskName `
        -Action (New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$launcherPath`"" -WorkingDirectory $installDirectory) `
        -Trigger (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME") `
        -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)) `
        -Description 'Tab Downloader A Media Helper (127.0.0.1:17385)' | Out-Null
    Write-Output "로그온 자동 실행 등록 완료: 작업 스케줄러 '$taskName'"
} catch {
    Write-Warning "로그온 자동 실행 등록에 실패했습니다: $($_.Exception.Message)"
    Write-Warning "재부팅 후에는 start.ps1을 직접 실행해 주세요."
}

& (Join-Path $projectDirectory 'start.ps1')
Write-Output "Media Helper 설치 완료: $installDirectory"
