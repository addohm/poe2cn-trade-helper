# refresh.ps1 - one-command rebuild after a PoE2 CN content patch.
#
# Unified pipeline (see UNIFY-DICT-HANDOFF.md): all client-derived content now
# comes from the sibling dictionary repo  ..\..\poe2-en-cn-dict  (single source of
# truth). This script (1) regenerates that repo's trade-helper consumer export,
# (2) fetches the live trade endpoints and rebuilds the userscript, (3) publishes.
#
#   Run from anywhere:  powershell -ExecutionPolicy Bypass -File <...>\tool\refresh.ps1
#
# FULL content refresh after a patch: first rebuild the dictionary itself in
# poe2-en-cn-dict (its own  python update.py , which reads the WeGame + Steam
# clients). THEN run this script. If you skip that, the export is regenerated from
# whatever dictionary/ output is already committed there.
#
# After it finishes: review dist\report.md, then reload the userscript in
# Tampermonkey (or let it auto-update if you've set that up).
# NOTE: keep this file ASCII-only (Windows PowerShell mis-reads UTF-8 w/o BOM).

$ErrorActionPreference = 'Stop'
$tool = $PSScriptRoot
$proj = Split-Path $tool -Parent
$dictRepo = Join-Path (Split-Path $proj -Parent) 'poe2-en-cn-dict'

if (-not (Test-Path $dictRepo)) {
  throw "Dictionary repo not found at $dictRepo (expected sibling of poe2cn-trade-helper)."
}
$wslDict = (wsl wslpath -a "$dictRepo").Trim()
$wslTool = (wsl wslpath -a "$tool").Trim()

Write-Host '== 1/2  Regenerate consumer export from poe2-en-cn-dict ==' -ForegroundColor Cyan
wsl python3 "$wslDict/export_consumers.py"

Write-Host '== 2/2  Fetch live trade endpoints + build dictionary and userscript ==' -ForegroundColor Cyan
wsl python3 "$wslTool/build_dict.py"

# Publish the rebuilt userscript to GitHub so every browser (incl. Linux) can
# auto-update from the raw URL. Requires an 'origin' remote + cached credentials
# (one-time setup in README). Skips cleanly if not configured.
Write-Host '== Publish  Push userscript to GitHub (for auto-update) ==' -ForegroundColor Cyan
Push-Location $proj
try {
  $remotes = @(git remote 2>$null)
  if ($remotes -notcontains 'origin') {
    Write-Host '  No "origin" remote - skipping push (see README to set it up once).' -ForegroundColor Yellow
  } else {
    git add tool/dist/poe2cn-trade.user.js
    if (@(git status --porcelain tool/dist/poe2cn-trade.user.js).Count -gt 0) {
      $ver = (Select-String -Path (Join-Path $tool 'dist\poe2cn-trade.user.js') -Pattern '@version\s+(\S+)' | Select-Object -First 1).Matches.Groups[1].Value
      git commit -q -m "Rebuild userscript $ver"
      git push -q origin main
      Write-Host "  Pushed userscript $ver." -ForegroundColor Green
    } else {
      Write-Host '  Userscript unchanged - nothing to push.' -ForegroundColor Gray
    }
  }
} finally { Pop-Location }

$report = Join-Path $tool 'dist\report.md'
$script = Join-Path $tool 'dist\poe2cn-trade.user.js'
Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "  - Review:  $report   (coverage + diff vs previous build)"
Write-Host "  - Install: reload $script in Tampermonkey"
