# Battle Interrupt Test Runner (PowerShell)
# 
# Usage:
#   .\run-battle-interrupt-tests.ps1 [options]
#
# Options:
#   -All            Run all battle interrupt tests (default)
#   -Explorer       Run explorer routine tests only
#   -Miner          Run miner routine tests only
#   -Trader         Run trader routine tests only
#   -Rescue         Run rescue routine tests only
#   -EdgeCases      Run edge case tests only
#   -Verbose        Show detailed output
#   -Watch          Watch mode (re-run on file changes)
#   -Help           Show this help message

param(
    [switch]$All,
    [switch]$Explorer,
    [switch]$Miner,
    [switch]$Trader,
    [switch]$Rescue,
    [switch]$EdgeCases,
    [switch]$Verbose,
    [switch]$Watch,
    [switch]$Help
)

# Show help if requested
if ($Help) {
    Write-Host @"
Battle Interrupt Test Runner

Usage:
  .\run-battle-interrupt-tests.ps1 [options]

Options:
  -All            Run all battle interrupt tests (default)
  -Explorer       Run explorer routine tests only
  -Miner          Run miner routine tests only
  -Trader         Run trader routine tests only
  -Rescue         Run rescue routine tests only
  -EdgeCases      Run edge case tests only
  -Verbose        Show detailed output
  -Watch          Watch mode (re-run on file changes)
  -Help           Show this help message

Examples:
  # Run all tests
  .\run-battle-interrupt-tests.ps1

  # Run explorer tests only
  .\run-battle-interrupt-tests.ps1 -Explorer

  # Run in watch mode
  .\run-battle-interrupt-tests.ps1 -Watch
"@
    exit 0
}

Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Blue
Write-Host "  Battle Interrupt Test Suite" -ForegroundColor Blue
Write-Host "  Testing critical jump interrupt handling" -ForegroundColor Blue
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Blue
Write-Host ""

# Determine test pattern
$TestPattern = ""
if ($Explorer) { $TestPattern = "Explorer Routine" }
elseif ($Miner) { $TestPattern = "Miner Routine" }
elseif ($Trader) { $TestPattern = "Trader Routine" }
elseif ($Rescue) { $TestPattern = "Rescue Routine" }
elseif ($EdgeCases) { $TestPattern = "Edge Cases" }

# Check if bun is installed
try {
    $null = Get-Command bun -ErrorAction Stop
} catch {
    Write-Host "Error: bun is not installed" -ForegroundColor Red
    Write-Host "Please install bun: https://bun.sh/"
    exit 1
}

# Navigate to project root
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

# Build command
$TestFile = "tests\battle-interrupt-routines.test.ts"
$Arguments = @("test", $TestFile)

if ($TestPattern) {
    $Arguments += "-t"
    $Arguments += $TestPattern
}

if ($Verbose) {
    $Arguments += "--verbose"
}

if ($Watch) {
    $Arguments += "--watch"
}

# Run tests
Write-Host "Running tests..." -ForegroundColor Blue
Write-Host "Command: bun $($Arguments -join ' ')" -ForegroundColor Yellow
Write-Host ""

if ($TestPattern) {
    Write-Host "Test scope: " -NoNewline -ForegroundColor Blue
    Write-Host "$TestPattern" -ForegroundColor Yellow
} else {
    Write-Host "Test scope: " -NoNewline -ForegroundColor Blue
    Write-Host "All battle interrupt tests" -ForegroundColor Green
}

Write-Host ""

# Execute tests
$Process = Start-Process -FilePath "bun" -ArgumentList $Arguments -NoNewWindow -Wait -PassThru

if ($Process.ExitCode -eq 0) {
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Green
    Write-Host "  ✅ All tests passed!" -ForegroundColor Green
    Write-Host "  Battle interrupt handling is working correctly." -ForegroundColor Green
    Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Green
    exit 0
} else {
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Red
    Write-Host "  ❌ Some tests failed!" -ForegroundColor Red
    Write-Host "  Review the failures above and fix the routine implementations." -ForegroundColor Red
    Write-Host "  See tests/BATTLE_INTERRUPT_TESTING.md for details." -ForegroundColor Red
    Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Red
    exit 1
}
