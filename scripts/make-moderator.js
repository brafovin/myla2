// Befoerdert einen vorhandenen Nutzer zum Moderator.
// Aufruf:  node --experimental-sqlite scripts/make-moderator.js <username>
import { db } from '../server/db.js';

const username = process.argv[2];
if (!username) {
  console.error('Aufruf: node scripts/make-moderator.js <username>');
  process.exit(1);
}

const result = db
  .prepare('UPDATE users SET is_moderator = 1 WHERE username = ?')
  .run(username);

if (result.changes === 0) {
  console.error(`Nutzer "${username}" nicht gefunden.`);
  process.exit(1);
}
console.log(`@${username} ist jetzt Moderator.`);
