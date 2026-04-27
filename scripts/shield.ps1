param(
  [Parameter(Position = 0)]
  [string]$Command = "help",

  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ShieldRoot = Join-Path $RepoRoot "Agents-of-SHIELD"
$RequirementsPath = Join-Path $ShieldRoot "requirements.txt"
$RunnerPath = Join-Path $ShieldRoot "run_orchestrator.py"

if (-not (Test-Path $ShieldRoot)) {
  throw "Agents-of-SHIELD folder not found at $ShieldRoot"
}

if (-not (Test-Path $RunnerPath)) {
  throw "run_orchestrator.py not found at $RunnerPath"
}

function Test-PythonWithYaml {
  param([string]$PythonExe)

  if (-not $PythonExe) {
    return $false
  }

  try {
    & $PythonExe -c "import yaml" *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Resolve-ShieldPython {
  $candidates = New-Object System.Collections.Generic.List[string]

  if ($env:SHIELD_PYTHON) {
    $candidates.Add($env:SHIELD_PYTHON)
  }

  try {
    $wherePython = & where.exe python 2>$null
    foreach ($candidate in $wherePython) {
      if ($candidate -and -not $candidates.Contains($candidate)) {
        $candidates.Add($candidate)
      }
    }
  } catch {
    # Ignore missing where.exe or empty result.
  }

  foreach ($candidate in $candidates) {
    if (Test-PythonWithYaml $candidate) {
      return $candidate
    }
  }

  if ($candidates.Count -gt 0) {
    return $candidates[0]
  }

  return "python"
}

function Invoke-ShieldPython {
  param([string[]]$CommandArgs)

  $pythonExe = Resolve-ShieldPython
  Write-Host "[shield] Using Python: $pythonExe"
  Push-Location $ShieldRoot
  try {
    & $pythonExe @CommandArgs 2>&1 | ForEach-Object { $_ }
    return $LASTEXITCODE
  } finally {
    Pop-Location
  }
}

switch ($Command.ToLowerInvariant()) {
  "bootstrap" {
    if (-not (Test-Path $RequirementsPath)) {
      throw "requirements.txt not found at $RequirementsPath"
    }

    $pythonExe = Resolve-ShieldPython
    Write-Host "[shield] Using Python: $pythonExe"
    & $pythonExe -m pip install -r $RequirementsPath
    exit $LASTEXITCODE
  }

  "compile" {
    $argsToRun = @($RunnerPath, "compile")
    $exitCode = Invoke-ShieldPython -CommandArgs $argsToRun
    exit $exitCode
  }

  "plan" {
    if (-not $RemainingArgs -or $RemainingArgs.Count -lt 1) {
      throw "Usage: scripts/shield.ps1 plan <task-path-relative-to-Agents-of-SHIELD>"
    }
    $taskPath = $RemainingArgs[0]
    if (-not [System.IO.Path]::IsPathRooted($taskPath)) {
      $taskPath = Join-Path $ShieldRoot $taskPath
    }
    $extraArgs = @()
    if ($RemainingArgs.Count -gt 1) {
      $extraArgs = $RemainingArgs[1..($RemainingArgs.Count - 1)]
    }
    $argsToRun = @($RunnerPath, "plan", $taskPath) + $extraArgs
    $exitCode = Invoke-ShieldPython -CommandArgs $argsToRun
    exit $exitCode
  }

  "run" {
    if (-not $RemainingArgs -or $RemainingArgs.Count -lt 1) {
      throw "Usage: scripts/shield.ps1 run <task-path-relative-to-Agents-of-SHIELD>"
    }
    $taskPath = $RemainingArgs[0]
    if (-not [System.IO.Path]::IsPathRooted($taskPath)) {
      $taskPath = Join-Path $ShieldRoot $taskPath
    }
    $extraArgs = @()
    if ($RemainingArgs.Count -gt 1) {
      $extraArgs = $RemainingArgs[1..($RemainingArgs.Count - 1)]
    }
    $argsToRun = @($RunnerPath, "run", $taskPath) + $extraArgs
    $exitCode = Invoke-ShieldPython -CommandArgs $argsToRun
    exit $exitCode
  }

  default {
    Write-Host "Usage:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/shield.ps1 bootstrap"
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/shield.ps1 compile"
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/shield.ps1 plan tasks/architecture/TASK-ARCH-001-runtime-architecture.yaml"
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/shield.ps1 run tasks/architecture/<task>.yaml"
    exit 1
  }
}
