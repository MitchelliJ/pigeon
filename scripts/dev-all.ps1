# Starts local Postgres, waits for it to accept connections, applies all
# migrations, and only then launches the frontend+API and worker. This keeps
# schema-dependent processes from racing database initialization.
#
# Uses one dedicated Windows Terminal window with three tabs; falls back to
# separate PowerShell windows if wt.exe isn't installed. See docs/LOCAL_SETUP.md.

$repoRoot = Split-Path -Parent $PSScriptRoot
$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
$terminalWindow = "pigeon-dev-$PID"

function Open-DevTerminal {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$Command
    )

    if ($wt) {
        # Address every tab to the same unique window. Without `-w`, Windows
        # Terminal may honor the user's new-instance behavior and open a
        # separate window for each Start-Process call.
        Start-Process wt.exe -ArgumentList @(
            "-w", $terminalWindow,
            "new-tab", "--title", $Title, "-d", $repoRoot,
            "powershell", "-NoExit", "-Command", $Command
        )
    } else {
        Start-Process powershell -ArgumentList @(
            "-NoExit", "-Command", "Set-Location '$repoRoot'; $Command"
        )
    }
}

if (-not $wt) {
    Write-Host "Windows Terminal (wt.exe) not found - opening separate PowerShell windows instead."
}

Open-DevTerminal -Title "dev:db" -Command "pnpm dev:db"

Write-Host "Waiting for local Postgres on 127.0.0.1:5432 ..."
$databaseReady = $false
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect("127.0.0.1", 5432)
        $databaseReady = $true
        break
    } catch {
        Start-Sleep -Milliseconds 500
    } finally {
        $client.Dispose()
    }
}

if (-not $databaseReady) {
    Write-Error "Postgres did not become ready within 60 seconds. Check the dev:db terminal."
    exit 1
}

Write-Host "Postgres is reachable. Applying migrations ..."
$migrationExitCode = 1
Push-Location $repoRoot
try {
    & pnpm migrate
    $migrationExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($migrationExitCode -ne 0) {
    Write-Error "Database migrations failed (exit code $migrationExitCode). API and worker were not started."
    exit $migrationExitCode
}

Write-Host "Migrations complete. Starting app and worker ..."
Open-DevTerminal -Title "dev" -Command "pnpm dev"
Open-DevTerminal -Title "dev:worker" -Command "pnpm dev:worker"
