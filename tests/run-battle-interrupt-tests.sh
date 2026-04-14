#!/bin/bash
# Battle Interrupt Test Runner
# 
# Usage:
#   ./run-battle-interrupt-tests.sh [options]
#
# Options:
#   --all           Run all battle interrupt tests (default)
#   --explorer      Run explorer routine tests only
#   --miner         Run miner routine tests only
#   --trader        Run trader routine tests only
#   --rescue        Run rescue routine tests only
#   --edge-cases    Run edge case tests only
#   --verbose       Show detailed output
#   --watch         Watch mode (re-run on file changes)
#   --help          Show this help message

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Battle Interrupt Test Suite${NC}"
echo -e "${BLUE}  Testing critical jump interrupt handling${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Default to all tests
TEST_PATTERN=""
WATCH_MODE=""
VERBOSE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --all)
      TEST_PATTERN=""
      shift
      ;;
    --explorer)
      TEST_PATTERN="Explorer Routine"
      shift
      ;;
    --miner)
      TEST_PATTERN="Miner Routine"
      shift
      ;;
    --trader)
      TEST_PATTERN="Trader Routine"
      shift
      ;;
    --rescue)
      TEST_PATTERN="Rescue Routine"
      shift
      ;;
    --edge-cases)
      TEST_PATTERN="Edge Cases"
      shift
      ;;
    --verbose)
      VERBOSE="--verbose"
      shift
      ;;
    --watch)
      WATCH_MODE="--watch"
      shift
      ;;
    --help)
      cat << 'EOF'
Usage:
  ./run-battle-interrupt-tests.sh [options]

Options:
  --all           Run all battle interrupt tests (default)
  --explorer      Run explorer routine tests only
  --miner         Run miner routine tests only
  --trader        Run trader routine tests only
  --rescue        Run rescue routine tests only
  --edge-cases    Run edge case tests only
  --verbose       Show detailed output
  --watch         Watch mode (re-run on file changes)
  --help          Show this help message

Examples:
  # Run all tests
  ./run-battle-interrupt-tests.sh

  # Run explorer tests only
  ./run-battle-interrupt-tests.sh --explorer

  # Run in watch mode
  ./run-battle-interrupt-tests.sh --watch
EOF
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# Check if bun is installed
if ! command -v bun &> /dev/null; then
  echo -e "${RED}Error: bun is not installed${NC}"
  echo "Please install bun: https://bun.sh/"
  exit 1
fi

# Navigate to project root (assuming script is in tests/)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Build command
TEST_FILE="tests/battle-interrupt-routines.test.ts"
CMD="bun test $TEST_FILE"

if [ -n "$TEST_PATTERN" ]; then
  CMD="$CMD -t \"$TEST_PATTERN\""
fi

if [ -n "$VERBOSE" ]; then
  CMD="$CMD $VERBOSE"
fi

if [ -n "$WATCH_MODE" ]; then
  CMD="$CMD $WATCH_MODE"
fi

# Run tests
echo -e "${BLUE}Running tests...${NC}"
echo -e "${YELLOW}Command: $CMD${NC}"
echo ""

if [ -n "$TEST_PATTERN" ]; then
  echo -e "${BLUE}Test scope: ${YELLOW}$TEST_PATTERN${NC}"
else
  echo -e "${BLUE}Test scope: ${GREEN}All battle interrupt tests${NC}"
fi

echo ""

# Execute
if eval $CMD; then
  echo ""
  echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  ✅ All tests passed!${NC}"
  echo -e "${GREEN}  Battle interrupt handling is working correctly.${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
  exit 0
else
  echo ""
  echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
  echo -e "${RED}  ❌ Some tests failed!${NC}"
  echo -e "${RED}  Review the failures above and fix the routine implementations.${NC}"
  echo -e "${RED}  See tests/BATTLE_INTERRUPT_TESTING.md for details.${NC}"
  echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
  exit 1
fi
