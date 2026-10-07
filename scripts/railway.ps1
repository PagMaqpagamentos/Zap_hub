param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $RailwayArguments
)

$ErrorActionPreference = 'Stop'
$zapTokenPath = Join-Path $env:LOCALAPPDATA 'ZapHub/railway-token.dpapi'
if (-not (Test-Path -LiteralPath $zapTokenPath)) {
    throw 'Credencial local do Zap_Hub não configurada neste usuário do Windows.'
}

$zapPreviousToken = $env:RAILWAY_TOKEN
$zapPreviousApiToken = $env:RAILWAY_API_TOKEN
$zapPreviousDirectory = Get-Location
$zapExitCode = 1
try {
    $zapSecureToken = Get-Content -Raw -LiteralPath $zapTokenPath | ConvertTo-SecureString
    $env:RAILWAY_TOKEN = [System.Net.NetworkCredential]::new('', $zapSecureToken).Password
    Remove-Item Env:RAILWAY_API_TOKEN -ErrorAction SilentlyContinue
    Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

    $zapStatusJson = & railway.cmd status --json
    if ($LASTEXITCODE -ne 0) { throw 'Não foi possível validar o acesso ao Railway.' }
    $zapStatus = $zapStatusJson | ConvertFrom-Json
    if ($zapStatus.id -ne '9632c69c-16f1-42ca-94ea-d694a01f6886') {
        throw 'A credencial não corresponde ao projeto Zap_Hub. Operação interrompida.'
    }

    if (-not $RailwayArguments) { $RailwayArguments = @('status') }
    & railway.cmd @RailwayArguments
    $zapExitCode = $LASTEXITCODE
} finally {
    $env:RAILWAY_TOKEN = $zapPreviousToken
    $env:RAILWAY_API_TOKEN = $zapPreviousApiToken
    Set-Location -LiteralPath $zapPreviousDirectory
}
exit $zapExitCode
