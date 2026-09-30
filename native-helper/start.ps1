$ErrorActionPreference = 'Stop'
$installDirectory = Join-Path $env:LOCALAPPDATA 'TabDownloaderAMediaHelper'
$configPath = Join-Path $installDirectory 'helper-config.json'
$serverPath = Join-Path $installDirectory 'server.cjs'
if (-not (Test-Path -LiteralPath $configPath) -or -not (Test-Path -LiteralPath $serverPath)) {
    throw 'Media Helper가 설치되지 않았습니다. install.ps1을 먼저 실행하세요.'
}

try {
    $status = Invoke-RestMethod -Uri 'http://127.0.0.1:17385/hello' -TimeoutSec 2
    if ($status.ok) { Write-Output 'Media Helper가 이미 실행 중입니다.'; exit 0 }
} catch { }

$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$nodePath = $config.nodePath
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Node.js 실행 파일을 찾지 못했습니다.' }
Start-Process -FilePath $nodePath -ArgumentList @("`"$serverPath`"", "`"$configPath`"") -WindowStyle Hidden

$ready = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    try {
        $status = Invoke-RestMethod -Uri 'http://127.0.0.1:17385/hello' -TimeoutSec 2
        if ($status.ok) { $ready = $true; break }
    } catch { }
}
if (-not $ready) { throw 'Media Helper가 제한 시간 안에 시작되지 않았습니다.' }
Write-Output "Media Helper 실행 완료: $($status.data.version)"
