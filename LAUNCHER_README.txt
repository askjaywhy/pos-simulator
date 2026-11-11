╔════════════════════════════════════════════════════════════════╗
║         POS SIMULATOR - AUTOMATED LAUNCHER SCRIPTS             ║
╚════════════════════════════════════════════════════════════════╝

TWO WAYS TO START THE ENTIRE SYSTEM:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OPTION 1: BATCH SCRIPT (Simplest - Recommended)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Open File Explorer
2. Navigate to: C:\Users\Askja\Documents\pos-simulator\
3. Double-click: START_POS_SIMULATOR.bat

✅ What happens:
   • 3 command windows open automatically
   • Terminal 1: Installs & starts Backend (Port 3001)
   • Terminal 2: Starts Frontend (Port 3000)
   • Terminal 3: Installs & runs Tests
   • Browser opens to http://localhost:3000

That's it! ✨

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OPTION 2: POWERSHELL SCRIPT (Alternative)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Open PowerShell as Administrator
2. Navigate to the pos-simulator folder
3. Run this command:

   powershell -ExecutionPolicy Bypass -File Start-POS-Simulator.ps1

✅ Same result as Option 1, but with PowerShell windows

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WHAT EACH TERMINAL DOES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Terminal 1 (Backend):
  • Title: "POS Simulator - Backend (Port 3001)"
  • Installs npm packages
  • Starts Express API server
  • Shows endpoints and status
  • Processes all transactions

Terminal 2 (Frontend):
  • Title: "POS Simulator - Frontend (Port 3000)"
  • Starts Python HTTP server
  • Serves the UI
  • Keep this running while using the app

Terminal 3 (Tests):
  • Title: "POS Simulator - Tests"
  • Installs Playwright (first time only)
  • Ready for running tests
  • Type: npm test (when ready to run tests)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FIRST TIME SETUP:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The scripts will automatically:
✅ Install npm dependencies (backend & tests)
✅ Install Playwright browsers (tests only - ~300MB)
✅ Start all servers
✅ Open browser to http://localhost:3000

First run may take 2-3 minutes while dependencies download.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

USING THE APPLICATION:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Browser opens automatically to: http://localhost:3000

1. Select a test card from dropdown, OR enter manually:
   Card: 4111111111111111
   Exp: 12/28
   CVV: 123
   Amount: 99.99

2. Click "PROCESS TRANSACTION"

3. View results:
   • Summary tab: Transaction details
   • EMV Tags tab: All EMV tag data
   • ISO 8583 tab: All ISO 8583 fields

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RUNNING TESTS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

In Terminal 3, type:

  npm test              # Run all tests (32+)
  npm run test:headed   # Show browser during tests
  npm run test:debug    # Step through tests

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STOPPING SERVICES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

To stop any service, press Ctrl+C in that terminal window.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TROUBLESHOOTING:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Port 3001 already in use?
  → Close any other app using that port, OR
  → In Terminal 1, stop the script and run: PORT=3002 npm start

Port 3000 already in use?
  → In Terminal 2, stop the script and run: python3 -m http.server 8000
  → Then go to http://localhost:8000

Node.js not found?
  → Install from: https://nodejs.org (v14 or higher)
  → Restart your computer after installing

Python not found?
  → Install from: https://www.python.org
  → Or use Windows Store Python

Browser didn't open?
  → Manually go to: http://localhost:3000

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Need more details? See:
  • README.md - Project overview
  • SETUP_GUIDE.md - Manual step-by-step guide
  • ARCHITECTURE.txt - System architecture

╔════════════════════════════════════════════════════════════════╗
║  🎉 Everything is ready! Just double-click the .bat file!     ║
╚════════════════════════════════════════════════════════════════╝
