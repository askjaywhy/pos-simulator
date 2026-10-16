import { test as base } from '@playwright/test';
import { TerminalPage } from './pages/TerminalPage.js';

// Injects page objects into agent-built UI specs (tests/ui/agent/).
export const test = base.extend({
  terminal: async ({ page }, use) => {
    await use(new TerminalPage(page));
  },
});

export { expect } from '@playwright/test';
