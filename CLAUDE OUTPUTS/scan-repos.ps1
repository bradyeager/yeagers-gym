# scan-repos.ps1
# Scans every git repo under the given root paths and writes a markdown
# checklist of loose ends: uncommitted changes, untracked files, stale
# unmerged branches, TODO/FIXME markers, recently-modified-but-uncommitted
# files, and stub functions.
#
# Usage (from PowerShell):
#   cd "C:\Users\brad\OneDrive\Yeager Docs\CLAUDE OUTPUTS"
#   .\scan-repos.ps1
#
# Edit $Roots below if your repo locations change.

$Roots = @(
    "C:\Users\brad",
    "C:\Users\brad\OneDrive\Yeager Docs"
)

$Today    = Get-Date -Format "yyyy-MM-dd"
$OutFile  = Join-Path $PSScriptRoot "code-pending-scan-$Today.md"
$StaleDays = 7
$ModifiedWindowDays = 30

# Folders to skip when walking
$SkipDirs = @('node_modules', '.next', 'dist', 'build', '.venv', 'venv', '__pycache__', '.cache')

# Source extensions to grep for TODO/FIXME and stubs
$SourceExt = @('*.js','*.mjs','*.ts','*.tsx','*.jsx','*.py','*.rb','*.go','*.rs','*.html','*.css','*.md','*.sh','*.ps1')

function Find-GitRepos {
    param([string[]]$Paths)
    $repos = @()
    foreach ($p in $Paths) {
        if (-not (Test-Path $p)) { continue }
        # A repo = a directory containing a .git folder (skip nested .git inside ignored dirs)
        Get-ChildItem -Path $p -Recurse -Force -Directory -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -eq '.git' -and
                ($SkipDirs -notcontains $_.Parent.Name) -and
                ($_.FullName -notmatch '\\node_modules\\')
            } |
            ForEach-Object { $repos += $_.Parent.FullName }
    }
    return $repos | Sort-Object -Unique
}

function Invoke-Git {
    param([string]$RepoPath, [string]$Args)
    Push-Location $RepoPath
    try {
        $output = & git $Args.Split(' ') 2>$null
        return $output
    } finally { Pop-Location }
}

function Scan-Repo {
    param([string]$RepoPath)

    Push-Location $RepoPath
    try {
        $name = Split-Path $RepoPath -Leaf

        # 1. Uncommitted (staged + unstaged)
        $status = git status --short 2>$null

        # 2. Untracked
        $untracked = git ls-files --others --exclude-standard 2>$null

        # 3. Stale unmerged branches (local + remote)
        $cutoff = (Get-Date).AddDays(-$StaleDays)
        $allBranches = git for-each-ref --format='%(refname:short)|%(committerdate:iso8601)' refs/heads/ refs/remotes/ 2>$null
        $mainRef = (git rev-parse --verify --quiet origin/main 2>$null) ; if (-not $mainRef) { $mainRef = (git rev-parse --verify --quiet main 2>$null) }
        $staleBranches = @()
        foreach ($line in $allBranches) {
            if (-not $line) { continue }
            $parts = $line -split '\|'
            $br = $parts[0]; $when = [datetime]$parts[1]
            if ($br -eq 'main' -or $br -eq 'origin/main' -or $br -eq 'origin/HEAD' -or $br -match 'HEAD$') { continue }
            if ($when -gt $cutoff) { continue }
            if ($mainRef) {
                $merged = git merge-base --is-ancestor $br $mainRef 2>$null; $isMerged = ($LASTEXITCODE -eq 0)
                if ($isMerged) { continue }
            }
            $ahead = (git rev-list --count "$mainRef..$br" 2>$null)
            $staleBranches += [pscustomobject]@{ Branch=$br; Date=$when.ToString('yyyy-MM-dd'); Ahead=$ahead }
        }

        # 4. TODO / FIXME / XXX / HACK
        $markers = @()
        $files = Get-ChildItem -Recurse -File -Include $SourceExt -ErrorAction SilentlyContinue |
                 Where-Object { $f = $_.FullName; -not ($SkipDirs | Where-Object { $f -match "\\$_\\" }) -and $f -notmatch '\\\.git\\' }
        foreach ($f in $files) {
            $matches = Select-String -Path $f.FullName -Pattern '\b(TODO|FIXME|XXX|HACK)\b' -ErrorAction SilentlyContinue
            foreach ($m in $matches) {
                $rel = Resolve-Path -Relative $m.Path
                $markers += "  - ``$rel:$($m.LineNumber)`` — $($m.Line.Trim())"
            }
        }

        # 5. Stub functions (best-effort heuristics)
        $stubs = @()
        foreach ($f in $files) {
            $lines = Get-Content $f.FullName -ErrorAction SilentlyContinue
            for ($i = 0; $i -lt $lines.Count - 1; $i++) {
                $cur = $lines[$i]; $nxt = $lines[$i+1].Trim()
                if ($cur -match '^\s*def\s+\w+.*:\s*$' -and ($nxt -eq 'pass' -or $nxt -eq '...' -or $nxt -match 'NotImplementedError')) {
                    $rel = Resolve-Path -Relative $f.FullName
                    $stubs += "  - ``$rel:$($i+1)`` — $($cur.Trim())"
                }
                if ($cur -match 'function\s+\w+|=>\s*\{' -and $nxt -match 'throw .*not implemented') {
                    $rel = Resolve-Path -Relative $f.FullName
                    $stubs += "  - ``$rel:$($i+1)`` — $($cur.Trim())"
                }
            }
        }

        # 6. Files modified in last N days but never committed (untracked OR uncommitted modifications)
        $recentLoose = @()
        $cutoff30 = (Get-Date).AddDays(-$ModifiedWindowDays)
        $tracked = @{}
        (git ls-files 2>$null) | ForEach-Object { $tracked[$_] = $true }
        $changed = @{}
        (git diff --name-only HEAD 2>$null) | ForEach-Object { $changed[$_] = $true }
        $candidates = Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue |
                      Where-Object { $_.LastWriteTime -gt $cutoff30 -and $_.FullName -notmatch '\\\.git\\' -and -not ($SkipDirs | Where-Object { $_f = $_; ($candidates.FullName) -match "\\$_f\\" }) }
        foreach ($c in $candidates) {
            $rel = (Resolve-Path -Relative $c.FullName) -replace '\\','/'
            $relGit = $rel -replace '^\./',''
            if (-not $tracked.ContainsKey($relGit)) {
                $recentLoose += "  - ``$rel`` (untracked, modified $($c.LastWriteTime.ToString('yyyy-MM-dd')))"
            } elseif ($changed.ContainsKey($relGit)) {
                $recentLoose += "  - ``$rel`` (uncommitted changes, modified $($c.LastWriteTime.ToString('yyyy-MM-dd')))"
            }
        }

        # Build markdown section
        $md = @()
        $md += ""
        $md += "## $name (`$RepoPath`)"
        $md += ""

        if ($status -or $untracked -or $staleBranches -or $markers -or $stubs -or $recentLoose) {
            $md += "### Most actionable"
            $md += ""
            if ($staleBranches) {
                foreach ($b in $staleBranches) {
                    $md += "- [ ] **Stale unmerged branch ``$($b.Branch)``** — last commit $($b.Date), $($b.Ahead) commits ahead of main. Merge, PR, or delete."
                }
            }
            if ($status) {
                $md += "- [ ] **Uncommitted changes**:"
                foreach ($s in $status) { $md += "  - ``$s``" }
            }
            if ($untracked) {
                $md += "- [ ] **Untracked files**:"
                foreach ($u in $untracked) { $md += "  - ``$u``" }
            }
            if ($recentLoose) {
                $md += "- [ ] **Recently modified but not committed (last $ModifiedWindowDays days)**:"
                $md += $recentLoose
            }
            if ($markers) {
                $md += "- [ ] **TODO / FIXME / XXX / HACK markers**:"
                $md += $markers
            }
            if ($stubs) {
                $md += "- [ ] **Possible stub / half-finished functions**:"
                $md += $stubs
            }
        } else {
            $md += "_Clean — nothing actionable._"
        }
        $md += ""
        return ($md -join "`r`n")

    } finally { Pop-Location }
}

# ---- main ----

Write-Host "Finding repos under: $($Roots -join ', ')"
$repos = Find-GitRepos -Paths $Roots
Write-Host "Found $($repos.Count) repos."

$header = @"
# Code Pending Scan — $Today

Auto-generated by ``scan-repos.ps1``. Inventory of loose ends across every git repo under:
$( ($Roots | ForEach-Object { "- ``$_``" }) -join "`r`n" )

Stale-branch threshold: $StaleDays days. Modified-window: $ModifiedWindowDays days.

---
"@

$sections = @()
foreach ($r in $repos) {
    Write-Host "  scanning $r"
    $sections += Scan-Repo -RepoPath $r
}

Set-Content -Path $OutFile -Value ($header + "`r`n" + ($sections -join "`r`n---`r`n")) -Encoding UTF8
Write-Host ""
Write-Host "Wrote: $OutFile"
