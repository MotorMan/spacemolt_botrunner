#!/bin/bash
# SpaceMolt BotRunner Watchdog
# Restarts the client if it exits with code 100 (mass disconnect restart request)
# Normal shutdown (exit code 0) will not trigger restart

set -euo pipefail

RESTART_DELAY=30
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "========================================"
echo "SpaceMolt BotRunner Watchdog"
echo "========================================"
echo "" 
echo "Configuration:"
echo "  - Restart delay: $RESTART_DELAY seconds"
echo "  - Working directory: $SCRIPT_DIR"
echo "  - Git pull on start: enabled"
echo ""
echo "Exit codes:"
echo "  - 0: Normal shutdown (no restart)"
echo "  - 100: Restart requested (mass disconnect detected)"
echo "  - Other: Unexpected exit (no restart)"
echo ""
echo "Press Ctrl+C to stop the watchdog."
echo "========================================"
echo ""

while true; do
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting SpaceMolt BotRunner..."
    echo ""

    set +e
    cd "$SCRIPT_DIR"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Running bun install..."
    bun install || echo "Warning: bun install failed"
    echo ""
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Running git pull..."
    git pull || echo "Warning: git pull failed or not a git repository"
    echo ""
    bun run src/botmanager.ts
    EXIT_CODE=$?
    set -e

    echo ""
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] BotRunner exited with code $EXIT_CODE"

    if [ "$EXIT_CODE" -eq 0 ]; then
        echo ""
        echo "=== Normal shutdown - no restart ==="
        echo ""
        break
    elif [ "$EXIT_CODE" -eq 100 ]; then
        echo ""
        echo "=== Restart requested ==="
        echo ""
        echo "Waiting $RESTART_DELAY seconds before restart..."
        sleep "$RESTART_DELAY"
        echo ""
        echo "=== Restarting BotRunner ==="
        echo ""
    else
        echo ""
        echo "=== Unexpected exit code $EXIT_CODE - no restart ==="
        echo ""
        break
    fi
done

echo "Watchdog stopped."
