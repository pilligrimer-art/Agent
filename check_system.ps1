# ============================================================
# check_system.ps1
# Environment diagnostics for Autonomous Agent
# Stack: Windows + Node.js + Ollama + local memory files
# ============================================================

param(
    [string]$ProjectPath = ""
)

$OK   = "[OK]  "
$WARN = "[~~]  "
$ERR  = "[!!]  "

$script:ErrorsCount = 0
$script:WarningsCount = 0

function Write-Header {
    param([string]$Text)

    Write-Host ""
    Write-Host ("=" * 60) -ForegroundColor DarkGray
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host ("=" * 60) -ForegroundColor DarkGray
}

function Write-Ok {
    param(
        [string]$Label,
        [string]$Value = ""
    )

    if ($Value) {
        Write-Host "  $OK$Label : $Value" -ForegroundColor Green
    } else {
        Write-Host "  $OK$Label" -ForegroundColor Green
    }
}

function Write-Warn {
    param(
        [string]$Label,
        [string]$Hint = ""
    )

    $script:WarningsCount++

    if ($Hint) {
        Write-Host "  $WARN$Label -> $Hint" -ForegroundColor Yellow
    } else {
        Write-Host "  $WARN$Label" -ForegroundColor Yellow
    }
}

function Write-Err {
    param(
        [string]$Label,
        [string]$Hint = ""
    )

    $script:ErrorsCount++

    if ($Hint) {
        Write-Host "  $ERR$Label -> $Hint" -ForegroundColor Red
    } else {
        Write-Host "  $ERR$Label" -ForegroundColor Red
    }
}

function Find-CommandPath {
    param([string[]]$Names)

    foreach ($name in $Names) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd) {
            return $cmd.Source
        }
    }

    return $null
}

function Run-Exe {
    param(
        [string]$FilePath,
        [string[]]$Arguments = @()
    )

    if (-not $FilePath) {
        return $null
    }

    try {
        $output = & $FilePath @Arguments 2>$null

        if ($null -eq $output) {
            return $null
        }

        return ($output | Out-String).Trim()
    }
    catch {
        return $null
    }
}

function Check-Required {
    param(
        [string]$Label,
        [string]$Value,
        [string]$Hint = ""
    )

    if ($Value) {
        Write-Ok $Label $Value
    } else {
        Write-Err "$Label : not found" $Hint
    }
}

function Check-Optional {
    param(
        [string]$Label,
        [string]$Value,
        [string]$Hint = ""
    )

    if ($Value) {
        Write-Ok $Label $Value
    } else {
        Write-Warn "$Label : missing" $Hint
    }
}

function Test-NodePackage {
    param(
        [string]$PackageName,
        [string]$NodePath
    )

    if (-not $NodePath) {
        return $false
    }

    try {
        $code = "require('$PackageName'); console.log('ok')"
        $result = & $NodePath -e $code 2>$null

        if (($result | Out-String).Trim() -eq "ok") {
            return $true
        }

        return $false
    }
    catch {
        return $false
    }
}

function Read-JsonFileSafe {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return $null
    }

    try {
        $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
        return $raw | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        return $null
    }
}

# ============================================================
# Resolve project path
# ============================================================

if (-not $ProjectPath) {
    if ($PSScriptRoot) {
        $ProjectPath = $PSScriptRoot
    } else {
        $ProjectPath = (Get-Location).Path
    }
}

$ProjectPath = [System.IO.Path]::GetFullPath($ProjectPath)

Write-Host ""
Write-Host "  ENVIRONMENT DIAGNOSTICS FOR AUTONOMOUS AGENT" -ForegroundColor White
Write-Host "  Node.js + Ollama pre-flight check" -ForegroundColor DarkGray
Write-Host "  Project path: $ProjectPath" -ForegroundColor DarkGray

if (-not (Test-Path $ProjectPath)) {
    Write-Err "Project path does not exist" $ProjectPath
    exit 1
}

Push-Location $ProjectPath

# ============================================================
# 1. Basic tools
# ============================================================

Write-Header "1. Basic tools"

$nodePath   = Find-CommandPath @("node.exe", "node")
$npmPath    = Find-CommandPath @("npm.cmd", "npm.exe", "npm")
$pythonPath = Find-CommandPath @("python.exe", "python3.exe", "python", "python3")
$gitPath    = Find-CommandPath @("git.exe", "git")
$ollamaPath = Find-CommandPath @("ollama.exe", "ollama")

$nodeVer = Run-Exe $nodePath @("--version")
$npmVer = Run-Exe $npmPath @("--version")
$pythonVer = Run-Exe $pythonPath @("--version")
$gitVer = Run-Exe $gitPath @("--version")

Check-Required "Node.js" $nodeVer "Install Node.js LTS from https://nodejs.org"
Check-Required "npm" $npmVer "npm is installed together with Node.js"
Check-Optional "Python" $pythonVer "Optional, useful for extra tools"
Check-Optional "Git" $gitVer "Install from https://git-scm.com"

# ============================================================
# 2. PATH validation
# ============================================================

Write-Header "2. PATH validation"

Check-Required "node in PATH" $nodePath "Add Node.js to PATH"
Check-Required "npm in PATH" $npmPath "Add npm to PATH"
Check-Required "ollama in PATH" $ollamaPath "Install Ollama from https://ollama.com"

# ============================================================
# 3. Ollama
# ============================================================

Write-Header "3. Ollama"

$ollamaVer = Run-Exe $ollamaPath @("--version")
Check-Required "ollama binary" $ollamaVer "Install Ollama from https://ollama.com"

$ollamaRunning = $false
$ollamaTags = $null

try {
    $ollamaTags = Invoke-RestMethod `
        -Uri "http://localhost:11434/api/tags" `
        -TimeoutSec 3 `
        -ErrorAction Stop

    Write-Ok "ollama server" "running on http://localhost:11434"
    $ollamaRunning = $true
}
catch {
    Write-Err "ollama server : NOT running" "Start it with: ollama serve"
}

if ($ollamaRunning) {
    if ($ollamaTags -and $ollamaTags.models -and $ollamaTags.models.Count -gt 0) {
        Write-Ok "Installed Ollama models" "$($ollamaTags.models.Count)"

        foreach ($model in $ollamaTags.models) {
            Write-Host "       * $($model.name)" -ForegroundColor Gray
        }
    } else {
        Write-Warn "No Ollama models found" "Pull one model before running the agent"
        Write-Host "       ollama pull llama3.2" -ForegroundColor DarkYellow
        Write-Host "       ollama pull phi3:mini" -ForegroundColor DarkYellow
        Write-Host "       ollama pull llama3.1:8b" -ForegroundColor DarkYellow
    }
}

# ============================================================
# 4. System resources
# ============================================================

Write-Header "4. System resources"

try {
    $systemDriveName = $env:SystemDrive.TrimEnd(":")
    $systemDrive = Get-PSDrive -Name $systemDriveName -ErrorAction SilentlyContinue

    if ($systemDrive) {
        $freeGB = [math]::Round($systemDrive.Free / 1GB, 1)

        if ($freeGB -ge 10) {
            Write-Ok "Disk free ($($systemDrive.Name):)" "$freeGB GB"
        } else {
            Write-Warn "Disk free ($($systemDrive.Name):) : $freeGB GB" "Low disk space"
        }
    } else {
        Write-Warn "Disk info unavailable"
    }
}
catch {
    Write-Warn "Disk info unavailable"
}

try {
    $os = Get-CimInstance Win32_OperatingSystem
    $freeRamGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    $totalRamGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)

    if ($freeRamGB -ge 6) {
        Write-Ok "RAM" "$freeRamGB GB free / $totalRamGB GB total"
    } elseif ($freeRamGB -ge 3) {
        Write-Warn "RAM : $freeRamGB GB free / $totalRamGB GB total" "Enough for small models, but close other apps"
    } else {
        Write-Warn "RAM : $freeRamGB GB free / $totalRamGB GB total" "Very low for local LLM; use phi3:mini or llama3.2 and close apps"
    }
}
catch {
    Write-Warn "RAM info unavailable"
}

# ============================================================
# 5. Project structure
# ============================================================

Write-Header "5. Project structure"

$expectedPaths = @{
    "package.json"          = "npm project file"
    ".env"                  = "environment config"
    "agent"                 = "agent source folder"
    "memory"                = "memory folder"
    "logs"                  = "logs folder"
    "memory\short_mem.json" = "short-term memory JSON"
    "memory\long_mem.json"  = "long-term memory JSON"
}

foreach ($item in $expectedPaths.GetEnumerator() | Sort-Object Name) {
    if (Test-Path $item.Key) {
        Write-Ok $item.Key "exists"
    } else {
        Write-Warn "$($item.Key) missing" $item.Value
    }
}

# ============================================================
# 6. package.json and Node.js packages
# ============================================================

Write-Header "6. Node.js packages"

$requiredPackages = @(
    "node-cron",
    "axios",
    "fs-extra",
    "dotenv"
)

if (-not (Test-Path "package.json")) {
    Write-Warn "package.json not found" "Run: npm init -y"
} else {
    $packageJson = Read-JsonFileSafe "package.json"

    if ($packageJson) {
        Write-Ok "package.json" "valid JSON"
    } else {
        Write-Err "package.json is invalid" "Fix JSON syntax"
    }
}

if (-not (Test-Path "node_modules")) {
    Write-Warn "node_modules missing" "Run: npm install node-cron axios fs-extra dotenv"
}

foreach ($pkg in $requiredPackages) {
    $installed = Test-NodePackage $pkg $nodePath

    if ($installed) {
        Write-Ok $pkg "installed"
    } else {
        Write-Warn "$pkg missing" "npm install $pkg"
    }
}

# ============================================================
# 7. .env validation
# ============================================================

Write-Header "7. .env validation"

if (Test-Path ".env") {
    $envRaw = Get-Content ".env" -ErrorAction SilentlyContinue

    $requiredEnvKeys = @(
        "OLLAMA_HOST",
        "MODEL_NAME",
        "DEFAULT_INTERVAL_SEC",
        "MAX_SHORT_MEM_IN_CONTEXT",
        "MAX_LONG_MEM_IN_CONTEXT",
        "MAX_TOKENS",
        "LOG_DIR",
        "MEMORY_DIR"
    )

    foreach ($key in $requiredEnvKeys) {
        $found = $envRaw | Where-Object { $_ -match "^\s*$key\s*=" }

        if ($found) {
            Write-Ok $key "set"
        } else {
            Write-Warn "$key missing" "add it to .env"
        }
    }
} else {
    Write-Warn ".env not found" "Create .env in project root"

    Write-Host ""
    Write-Host "  Suggested .env:" -ForegroundColor DarkGray
    Write-Host "       OLLAMA_HOST=http://localhost:11434" -ForegroundColor Gray
    Write-Host "       MODEL_NAME=llama3.2" -ForegroundColor Gray
    Write-Host "       DEFAULT_INTERVAL_SEC=3600" -ForegroundColor Gray
    Write-Host "       MAX_SHORT_MEM_IN_CONTEXT=5" -ForegroundColor Gray
    Write-Host "       MAX_LONG_MEM_IN_CONTEXT=5" -ForegroundColor Gray
    Write-Host "       MAX_TOKENS=1024" -ForegroundColor Gray
    Write-Host "       LOG_DIR=./logs" -ForegroundColor Gray
    Write-Host "       MEMORY_DIR=./memory" -ForegroundColor Gray
}

# ============================================================
# 8. Memory JSON validation
# ============================================================

Write-Header "8. Memory JSON validation"

$memoryFiles = @(
    "memory\short_mem.json",
    "memory\long_mem.json"
)

foreach ($mf in $memoryFiles) {
    if (-not (Test-Path $mf)) {
        Write-Warn "$mf missing" "Create file with: []"
        continue
    }

    $json = Read-JsonFileSafe $mf

    if ($null -eq $json) {
        Write-Err "$mf invalid JSON" "File must contain a JSON array, for example: []"
    } elseif ($json -is [array]) {
        Write-Ok $mf "valid JSON array, items: $($json.Count)"
    } else {
        Write-Warn "$mf is valid JSON but not an array" "Recommended content: []"
    }
}

# ============================================================
# 9. Quick recommendations
# ============================================================

Write-Header "9. Recommendations"

if (-not $nodeVer) {
    Write-Host "  1. Install Node.js LTS:" -ForegroundColor Yellow
    Write-Host "       https://nodejs.org" -ForegroundColor Gray
}

if (-not $ollamaVer) {
    Write-Host "  2. Install Ollama:" -ForegroundColor Yellow
    Write-Host "       https://ollama.com" -ForegroundColor Gray
}

if ($ollamaRunning -and (-not $ollamaTags.models -or $ollamaTags.models.Count -eq 0)) {
    Write-Host "  3. Pull a small model:" -ForegroundColor Yellow
    Write-Host "       ollama pull phi3:mini" -ForegroundColor Gray
    Write-Host "       ollama pull llama3.2" -ForegroundColor Gray
}

if (-not (Test-Path "package.json")) {
    Write-Host "  4. Initialize npm project:" -ForegroundColor Yellow
    Write-Host "       npm init -y" -ForegroundColor Gray
}

if (-not (Test-Path "node_modules")) {
    Write-Host "  5. Install dependencies:" -ForegroundColor Yellow
    Write-Host "       npm install node-cron axios fs-extra dotenv" -ForegroundColor Gray
}

if (-not (Test-Path "memory")) {
    Write-Host "  6. Create memory folder:" -ForegroundColor Yellow
    Write-Host "       mkdir memory" -ForegroundColor Gray
}

if (-not (Test-Path "logs")) {
    Write-Host "  7. Create logs folder:" -ForegroundColor Yellow
    Write-Host "       mkdir logs" -ForegroundColor Gray
}

# ============================================================
# Final summary
# ============================================================

Write-Host ""
Write-Host ("=" * 60) -ForegroundColor DarkGray
Write-Host "  Diagnostics complete" -ForegroundColor White
Write-Host ("=" * 60) -ForegroundColor DarkGray

Write-Host "  Errors   : $script:ErrorsCount" -ForegroundColor $(if ($script:ErrorsCount -gt 0) { "Red" } else { "Green" })
Write-Host "  Warnings : $script:WarningsCount" -ForegroundColor $(if ($script:WarningsCount -gt 0) { "Yellow" } else { "Green" })

Pop-Location