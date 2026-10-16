// "Ready" suite: everything except the 11 legacy UI specs (tests/ui/payment-form-*.spec.js),
// which target locators the terminal UI doesn't have. Run with: npm run test:ready
const base = require('./playwright.config.js');

module.exports = {
  ...base,
  testIgnore: ['**/ui/payment-form-*.spec.js'],
  reporter: [['list'], ['html', { open: 'never' }]],
};
