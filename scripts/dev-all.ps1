# Launches the three local-dev processes - Postgres ("pnpm dev:db"), the
# frontend+API ("pnpm dev"), and the worker ("pnpm dev:worker") - each in its
# own terminal, from the repo root. See docs/LOCAL_SETUP.md.
#
# Prefers Windows Terminal (three tabs in one window); falls back to three
# separate PowerShell windows if wt.exe isn't installed.

$repoRoot = Split-Path -Parent $PSScriptRoot

$commands = @(
    @{ Title = "dev:db"; Command = "pnpm dev:db" },
    @{ Title = "dev"; Command = "pnpm dev" },
    @{ Title = "dev:worker"; Command = "pnpm dev:worker" }
)

$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
if ($wt) {
    $wtArgs = @()
    foreach ($entry in $commands) {
        if ($wtArgs.Count -gt 0) { $wtArgs += ";" }
        $wtArgs += @(
            "new-tab", "--title", $entry.Title, "-d", $repoRoot,
            "powershell", "-NoExit", "-Command", $entry.Command
        )
    }
    Start-Process wt.exe -ArgumentList $wtArgs
} else {
    Write-Host "Windows Terminal (wt.exe) not found - opening separate PowerShell windows instead."
    foreach ($entry in $commands) {
        Start-Process powershell -ArgumentList @(
            "-NoExit", "-Command", "Set-Location '$repoRoot'; $($entry.Command)"
        )
    }
}
