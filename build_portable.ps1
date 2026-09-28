$ErrorActionPreference = 'Stop'
$rootPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$distPath = Join-Path $rootPath 'dist'
$packageName = 'AirChina-Leave-Assistant-Portable'
$packagePath = Join-Path $distPath $packageName
$zipPath = Join-Path $distPath "$packageName.zip"
$nodeSource = 'C:\Program Files\nodejs\node.exe'

if (-not (Test-Path -LiteralPath $nodeSource)) {
    throw "Node.js was not found: $nodeSource"
}
if (-not (Test-Path -LiteralPath (Join-Path $rootPath 'node_modules\playwright-core'))) {
    throw 'node_modules\playwright-core was not found.'
}

if (Test-Path -LiteralPath $packagePath) { Remove-Item -LiteralPath $packagePath -Recurse -Force }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

New-Item -ItemType Directory -Path $packagePath | Out-Null
New-Item -ItemType Directory -Path (Join-Path $packagePath 'runtime') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $packagePath 'node_modules') | Out-Null

$applicationFiles = @(
    'airchina_ui.html',
    'airchina_ui.js',
    'airchina_web.js',
    'airchina_config.json',
    'airchina_options.json',
    'package.json',
    'package-lock.json'
)
foreach ($file in $applicationFiles) {
    Copy-Item -LiteralPath (Join-Path $rootPath $file) -Destination (Join-Path $packagePath $file)
}

Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $packagePath 'runtime\node.exe')
Copy-Item -LiteralPath (Join-Path $rootPath 'node_modules\playwright-core') -Destination (Join-Path $packagePath 'node_modules\playwright-core') -Recurse
Get-ChildItem -LiteralPath (Join-Path $rootPath 'portable_templates') -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $packagePath $_.Name)
}

$nodeBootstrap = "const fs=require('node:fs');const original=fs.realpathSync;fs.realpathSync=Object.assign(function(p,o){try{return original(p,o)}catch(e){if(e.syscall==='lstat'&&(e.code==='EPERM'||e.code==='EACCES'))return original.native(p,o);throw e}},{native:original.native});require('node:module').runMain();"
& (Join-Path $packagePath 'runtime\node.exe') --eval $nodeBootstrap (Join-Path $packagePath 'airchina_web.js') --self-test-rules
if ($LASTEXITCODE -ne 0) { throw 'Portable rule self-test failed.' }
& (Join-Path $packagePath 'runtime\node.exe') --eval $nodeBootstrap (Join-Path $packagePath 'airchina_web.js') --validate-config
if ($LASTEXITCODE -ne 0) { throw 'Portable config validation failed.' }

Compress-Archive -LiteralPath $packagePath -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash
Set-Content -LiteralPath "$zipPath.sha256.txt" -Value "$hash  $packageName.zip" -Encoding ascii

$zip = Get-Item -LiteralPath $zipPath
Write-Output "PORTABLE_ZIP=$($zip.FullName)"
Write-Output "SIZE_BYTES=$($zip.Length)"
Write-Output "SHA256=$hash"
