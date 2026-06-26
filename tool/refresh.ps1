# refresh.ps1 - one-command rebuild after a PoE2 CN content patch.
# Re-datamines the CN client, re-fetches the live trade endpoints from both
# sites, and rebuilds dist/dict.json + dist/poe2cn-trade.user.js.
#
#   Run from anywhere:  powershell -ExecutionPolicy Bypass -File <...>\tool\refresh.ps1
#   (or right-click -> Run with PowerShell)
#
# After it finishes: review dist\report.md, then reload the userscript in
# Tampermonkey (or let it auto-update if you've set that up).
# NOTE: keep this file ASCII-only (Windows PowerShell mis-reads UTF-8 w/o BOM).

$ErrorActionPreference = 'Stop'
$tool = $PSScriptRoot
$wslTool = (wsl wslpath -a "$tool").Trim()

# Self-contained datamine: WSL node + this folder's own pathofexile-dat.
Write-Host '== 0/3  Ensure datamine deps (npm install if needed) ==' -ForegroundColor Cyan
wsl bash -lc "cd '$wslTool' && [ -d node_modules ] || npm install"

Write-Host '== 1/3  Datamine items / classes / skills / unique names ==' -ForegroundColor Cyan
wsl bash -lc "cd '$wslTool' && node extract_items.mjs --refresh-schema"

Write-Host '== 2/3  Datamine StatDescriptions (gem/skill stat lines + mods) ==' -ForegroundColor Cyan
wsl bash -lc "cd '$wslTool' && node extract_statdesc.mjs"

Write-Host '== 3/3  Fetch live trade endpoints + build dictionary and userscript ==' -ForegroundColor Cyan
wsl python3 "$wslTool/build_dict.py"

# Publish the rebuilt userscript to GitHub so every browser (incl. Linux) can
# auto-update from the raw URL. Requires an 'origin' remote + cached credentials
# (one-time setup in README). Skips cleanly if not configured.
Write-Host '== Publish  Push userscript to GitHub (for auto-update) ==' -ForegroundColor Cyan
$proj = Split-Path $tool -Parent
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
