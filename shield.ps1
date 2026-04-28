param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ShieldArgs
)

$ErrorActionPreference = "Stop"

$ProjectRoot = $PSScriptRoot
$Entrypoint = Join-Path $ProjectRoot ".shield\run.py"

& python $Entrypoint @ShieldArgs
exit $LASTEXITCODE
