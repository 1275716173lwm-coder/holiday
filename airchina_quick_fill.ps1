param(
    [switch]$RefreshFirst,
    [switch]$AllowSubmit
)

Add-Type -AssemblyName System.Windows.Forms

$native = @'
using System;
using System.Runtime.InteropServices;

public static class AirChinaFastInput
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
}
'@

Add-Type -TypeDefinition $native

$configPath = Join-Path $PSScriptRoot 'airchina_config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Configuration file was not found: $configPath"
}
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$startDate = [DateTime]::ParseExact([string]$config.startDate, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
$endDate = [DateTime]::ParseExact([string]$config.endDate, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
$expectedMonth = [DateTime]::Today.AddMonths(1)

if ($startDate.Year -ne $endDate.Year -or $startDate.Month -ne $endDate.Month) {
    throw 'Start and end dates must be in the same month.'
}
if ($startDate.Year -ne $expectedMonth.Year -or $startDate.Month -ne $expectedMonth.Month) {
    throw "Configured dates must be in the next calendar month: $($expectedMonth.ToString('yyyy-MM'))."
}
if ($endDate -lt $startDate) {
    throw 'End date cannot be earlier than start date.'
}

$expectedPosition = ([string][char]0x526F) + ([char]0x9A7E) + ([char]0x9A76)
if ([string]$config.flightPosition -ne $expectedPosition) {
    throw 'This calibrated script currently supports the first-officer position only.'
}

function ConvertFrom-CodePoints([int[]]$codes) {
    -join ($codes | ForEach-Object { [char]$_ })
}

$reasonYByText = @{}
$reasonYByText[(ConvertFrom-CodePoints @(0x0033,0x5929,0x5185,0x9884,0x5360))] = 732
$reasonYByText[(ConvertFrom-CodePoints @(0x7597,0x517B))] = 765
$reasonYByText[(ConvertFrom-CodePoints @(0x4EA7,0x5047))] = 797
$reasonYByText[(ConvertFrom-CodePoints @(0x516C,0x4F11))] = 828
$reasonYByText[(ConvertFrom-CodePoints @(0x63A2,0x4EB2,0x5047))] = 860
$reasonYByText[(ConvertFrom-CodePoints @(0x4E27,0x5047))] = 893
$reasonYByText[(ConvertFrom-CodePoints @(0x80B2,0x513F,0x5047))] = 925
$reasonYByText[(ConvertFrom-CodePoints @(0x4E8B,0x5047))] = 957
$reasonYByText[(ConvertFrom-CodePoints @(0x62A4,0x7406,0x5047))] = 989
$reasonYByText[(ConvertFrom-CodePoints @(0x75C5,0x5047))] = 1020
$reasonYByText[(ConvertFrom-CodePoints @(0x4E34,0x65F6,0x4E8B,0x5047))] = 1053
$reasonYByText[(ConvertFrom-CodePoints @(0x5A5A,0x5047))] = 1085
$reasonYByText[(ConvertFrom-CodePoints @(0x764C,0x75C7,0x5047))] = 1117

$configuredReason = [string]$config.leaveReason
if (-not $reasonYByText.ContainsKey($configuredReason)) {
    throw "Unsupported leave reason in configuration: $configuredReason"
}
$reasonY = [int]$reasonYByText[$configuredReason]

$process = Get-Process AirChina5.0 -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1

if (-not $process) {
    throw 'AirChina5.0 window was not found. Open the application and the application form first.'
}

$rect = New-Object AirChinaFastInput+RECT
[void][AirChinaFastInput]::GetWindowRect($process.MainWindowHandle, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

if ([Math]::Abs($width - 1549) -gt 8 -or [Math]::Abs($height - 1193) -gt 8) {
    throw "Window size is ${width}x${height}; expected approximately 1549x1193. Restore the calibrated window size before running."
}

function Click-Relative([int]$x, [int]$y, [int]$delayMs = 160) {
    [void][AirChinaFastInput]::SetCursorPos($rect.Left + $x, $rect.Top + $y)
    [AirChinaFastInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    [AirChinaFastInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds $delayMs
}

function Paste-Field([int]$x, [int]$y, [string]$value) {
    Click-Relative $x $y 180
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    Set-Clipboard -Value $value
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 180
}

function Get-DateCell([DateTime]$date, [int]$sundayX) {
    $firstDay = Get-Date -Year $date.Year -Month $date.Month -Day 1
    $column = [int]$date.DayOfWeek
    $row = [Math]::Floor(([int]$firstDay.DayOfWeek + $date.Day - 1) / 7)
    [pscustomobject]@{
        X = $sundayX + (32 * $column)
        Y = 953 + (40 * $row)
    }
}

$hadClipboard = $false
try {
    $oldClipboard = Get-Clipboard -Raw -ErrorAction Stop
    $hadClipboard = $true
} catch {}

try {
    [void][AirChinaFastInput]::SetForegroundWindow($process.MainWindowHandle)
    Start-Sleep -Milliseconds 300

    if ($RefreshFirst) {
        [System.Windows.Forms.SendKeys]::SendWait('^r')
        Start-Sleep -Milliseconds ([int]$config.refreshWaitMilliseconds)
    }

    # Refresh may preserve the previous scroll position. Always return to the form top.
    [void][AirChinaFastInput]::SetCursorPos($rect.Left + 1250, $rect.Top + 350)
    1..18 | ForEach-Object {
        [AirChinaFastInput]::mouse_event(0x0800, 0, 0, 120, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 25
    }
    Start-Sleep -Milliseconds 250

    Paste-Field 980 402 ([string]$config.personName)
    Paste-Field 980 488 ([string]$config.employeeId)

    # The page defaults to first officer. Select the configured leave reason.
    Click-Relative 980 690 250
    # Give the animated dropdown time to close before clicking the date field.
    Click-Relative 700 $reasonY 800

    $startCell = Get-DateCell $startDate 700
    Click-Relative 820 823 450
    Click-Relative $startCell.X $startCell.Y 350

    $endCell = Get-DateCell $endDate 1020
    Click-Relative 1145 823 450
    Click-Relative $endCell.X $endCell.Y 350

    Paste-Field 980 909 ([string]$config.days)

    if ([bool]$config.autoSubmit -and $AllowSubmit) {
        [void][AirChinaFastInput]::SetCursorPos($rect.Left + 1250, $rect.Top + 950)
        1..16 | ForEach-Object {
            [AirChinaFastInput]::mouse_event(0x0800, 0, 0, -120, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 35
        }
        Start-Sleep -Milliseconds 250
        Click-Relative 980 1082 600

        if ([bool]$config.autoConfirm) {
            Start-Sleep -Milliseconds 700
            [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        }
    }
} finally {
    if ($hadClipboard) {
        Set-Clipboard -Value $oldClipboard
    }
}

[System.Media.SystemSounds]::Asterisk.Play()
if ([bool]$config.autoSubmit -and $AllowSubmit) {
    Write-Host 'Form filled and the configured submit action was attempted.'
} else {
    Write-Host 'Form filled. Submit was not clicked.'
}
