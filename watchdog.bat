@echo off
REM SpaceMolt BotRunner Watchdog
REM Restarts the client if it exits with code 100 (mass disconnect restart request)
REM Normal shutdown (exit code 0) will not trigger restart

setlocal enabledelayedexpansion

set RESTART_DELAY=30
set SCRIPT_DIR=%~dp0

echo ========================================
echo SpaceMolt BotRunner Watchdog
echo ========================================
echo.
echo Configuration:
echo   - Restart delay: %RESTART_DELAY% seconds
echo   - Working directory: %SCRIPT_DIR%
echo   - Git pull on start: enabled
echo.
echo Exit codes:
echo   - 0: Normal shutdown (no restart)
echo   - 100: Restart requested (mass disconnect detected)
echo   - Other: Unexpected exit (no restart)
echo.
echo Press Ctrl+C to stop the watchdog.
echo ========================================
echo.

:loop
    echo [%date% %time%] Starting SpaceMolt BotRunner...
    echo.
    
    cd /d "%SCRIPT_DIR%"
    echo [%date% %time%] Running bun install...
    timeout /t 120 bun install || echo Warning: bun install failed or timed out
    echo.
    echo [%date% %time%] Running git pull...
    timeout /t 30 git pull || echo Warning: git pull failed, timed out, or not a git repository
    echo.
    bun run src\botmanager.ts
    set EXIT_CODE=%ERRORLEVEL%
    
    echo.
    echo [%date% %time%] BotRunner exited with code %EXIT_CODE%
    
    if %EXIT_CODE% EQU 0 (
        echo.
        echo === Normal shutdown - no restart ===
        echo.
        goto :end
    ) else if %EXIT_CODE% EQU 100 (
        echo.
        echo === Restart requested ===
        echo.
        echo Waiting %RESTART_DELAY% seconds before restart...
        timeout /t %RESTART_DELAY% /nobreak
        echo.
        echo === Restarting BotRunner ===
        echo.
        goto :loop
    ) else (
        echo.
        echo === Unexpected exit code %EXIT_CODE% - no restart ===
        echo.
        goto :end
    )

:end
    echo.
    echo Watchdog stopped.
    pause
