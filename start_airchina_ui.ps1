$ErrorActionPreference = 'Stop'
$rootPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodePath = 'C:\Program Files\nodejs\node.exe'
$panelUrl = 'http://127.0.0.1:32145/'

function Test-PanelReady {
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $task = $client.ConnectAsync('127.0.0.1', 32145)
        if (-not $task.Wait(250)) {
            $client.Dispose()
            return $false
        }
        $connected = $client.Connected
        $client.Dispose()
        return $connected
    } catch {
        return $false
    }
}

try {
    if (-not (Test-Path -LiteralPath $nodePath)) {
        throw 'Node.js was not found.'
    }

    if (-not (Test-PanelReady)) {
        Start-Process -FilePath $nodePath -ArgumentList 'airchina_ui.js' -WorkingDirectory $rootPath -WindowStyle Hidden
        $ready = $false
        for ($attempt = 0; $attempt -lt 50; $attempt++) {
            Start-Sleep -Milliseconds 100
            if (Test-PanelReady) {
                $ready = $true
                break
            }
        }
        if (-not $ready) {
            throw 'The panel service did not start within 5 seconds.'
        }
    }

    Start-Process $panelUrl
} catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        "Unable to open the panel.`n`n$($_.Exception.Message)",
        'Air China Assistant',
        'OK',
        'Error'
    ) | Out-Null
    exit 1
}
