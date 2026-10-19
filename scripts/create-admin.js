// Creates an admin account, or resets an existing account to admin with a new temporary password.
// Stop the server before running this: a running server keeps users in memory and would overwrite the change.
const auth = require('../auth');

(async () => {
  const username = process.argv[2] || 'admin';
  const password = auth.generatePassword();
  const existing = auth.findByName(username);
  if (existing) {
    existing.role = 'admin';
    existing.disabled = false;
    await auth.setPassword(existing, password, { mustChangePassword: true });
    auth.revokeUserSessions(existing.id);
  } else {
    await auth.createUser({ username, password, role: 'admin', mustChangePassword: true, createdBy: 'cli' });
  }
  auth.flush();
  console.log(`${existing ? 'Reset' : 'Created'} admin account.`);
  console.log('  username: [redacted]');
  console.log(`  password: ${password}`);
  console.log('You will be asked to choose a new password on first sign-in.');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
