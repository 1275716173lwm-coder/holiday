$ErrorActionPreference = 'Stop'
$rootPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodePath = Join-Path $rootPath 'runtime\node.exe'
$panelUrl = 'http://127.0.0.1:32145/'

function Test-PanelReady {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $panelUrl -TimeoutSec 1
        return $response.StatusCode -eq 200 -and $response.Content.Contains('id="requestForm"')
    } catch {
        return $false
    }
}

try {
    if (-not (Test-Path -LiteralPath $nodePath)) {
        throw 'Portable runtime is incomplete: runtime\node.exe is missing. Extract the full package again.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $rootPath 'node_modules\playwright-core'))) {
        throw 'Portable runtime is incomplete: playwright-core is missing. Extract the full package again.'
    }

    if (-not (Test-PanelReady)) {
        Start-Process -FilePath $nodePath -ArgumentList 'airchina_ui.js' -WorkingDirectory $rootPath -WindowStyle Hidden
        $ready = $false
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            Start-Sleep -Milliseconds 100
            if (Test-PanelReady) {
                $ready = $true
                break
            }
        }
        if (-not $ready) {
            throw 'The assistant did not start. Make sure local port 32145 is available.'
        }
    }

    Start-Process $panelUrl
} catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        "Unable to start the Air China assistant.`n`n$($_.Exception.Message)",
        'Air China Assistant',
        'OK',
        'Error'
    ) | Out-Null
    exit 1
}
