#!/bin/bash

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║      POS Simulator with EMV/ISO 8583 - Quick Start Setup       ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check prerequisites
echo "${BLUE}[1/5] Checking Prerequisites...${NC}"
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not installed"
    echo "Install from: https://nodejs.org"
    exit 1
fi
echo "✅ Node.js $(node --version)"

if ! command -v npm &> /dev/null; then
    echo "❌ npm not installed (comes with Node.js)"
    exit 1
fi
echo "✅ npm $(npm --version)"

if ! command -v python3 &> /dev/null; then
    echo "⚠️  Python 3 not found (optional, needed for frontend server)"
fi

echo ""

# Install backend dependencies
echo "${BLUE}[2/5] Installing Backend Dependencies...${NC}"
cd "$(dirname "$0")/backend"
npm install
if [ $? -ne 0 ]; then
    echo "❌ npm install failed"
    exit 1
fi
echo "✅ Backend dependencies installed"

echo ""

# Install test dependencies
echo "${BLUE}[3/5] Installing Test Dependencies...${NC}"
cd "$(dirname "$0")/tests"
npm install
if [ $? -ne 0 ]; then
    echo "⚠️  Test dependencies failed (optional)"
fi
echo "✅ Test dependencies ready"

echo ""

# Show next steps
echo "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo "${GREEN}✅ SETUP COMPLETE!${NC}"
echo "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""

echo "${YELLOW}📋 NEXT STEPS:${NC}"
echo ""
echo "Open THREE separate terminals and run:"
echo ""
echo "${BLUE}Terminal 1 - Backend:${NC}"
echo "  cd $(dirname "$0")/backend"
echo "  npm start"
echo ""
echo "${BLUE}Terminal 2 - Frontend:${NC}"
echo "  cd $(dirname "$0")/frontend"
echo "  python3 -m http.server 3000"
echo ""
echo "${BLUE}Terminal 3 - Tests (Optional):${NC}"
echo "  cd $(dirname "$0")/tests"
echo "  npm test"
echo ""
echo "${YELLOW}🌐 Then Open Browser:${NC}"
echo "  http://localhost:3000"
echo ""
echo "${YELLOW}💳 Test Transaction:${NC}"
echo "  Card:  4111111111111111"
echo "  Exp:   12/28"
echo "  CVV:   123"
echo "  Amount: 99.99"
echo ""
echo "${YELLOW}📚 Documentation:${NC}"
echo "  • README.md - Project overview"
echo "  • SETUP_GUIDE.md - Detailed setup guide"
echo "  • ARCHITECTURE.txt - System architecture"
echo ""
