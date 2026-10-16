# Agent kit — how to use it

Installed into this project:

```
CLAUDE.md                              project rules for all agents
.mcp.json                              Playwright MCP, locked to :3000 and :3001
.claude\settings.json                  wires the two hooks
.claude\agents\                        test-planner, test-generator, test-healer
.claude\hooks\guard.js                 blocks edits outside tests\ and specs\, and assertion tampering
.claude\hooks\log-heal.js              logs every page-object edit to heal-log\heals.jsonl
.claude\hooks\tests\guard.test.js      9 self-tests for the guard
tests\ui\pages\TerminalPage.js         page object for the terminal UI
tests\ui\fixtures.js                   injects the page object into specs
tests\ui\agent\terminal-sale.spec.js   reference spec in the house style (4 tests)
specs\                                 planner output goes here
heal-log\                              audit log goes here
```

Nothing in backend\, frontend\ or your existing tests was changed.

## Run
```powershell
node --test .claude\hooks\tests\guard.test.js     # 9 pass
.\Start-POS-Simulator.ps1                          # UI :3000, API :3001
cd tests; npx playwright test ui/agent --reporter=line
cd ..; claude
```

Inside Claude Code:
```
> Use the test-planner agent to plan the decline and refund flows on the terminal UI
> Use the test-generator agent to implement specs\<name>.plan.md
> Use the test-healer agent to fix failing tests in tests\ui\agent
```

## Interview demo
1. Rename "PROCESS TRANSACTION" in the UI → healer fixes one locator in TerminalPage.js,
   logged in heal-log\heals.jsonl.
2. Ask the healer about the Lost Card test → it classifies ASSERTION and reports the Luhn
   defect instead of "fixing" the test.
3. Ask Claude to "edit server.js so the history test passes" → guard blocks it.
