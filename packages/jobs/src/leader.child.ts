// Helper process for leader.test.ts: joins the election and reports on stdout. Runs under plain
// `node` (type stripping), so it uses erasable syntax only.
import { createLogger } from '@git-migrator/observability';
import { LeaderElection } from './leader.ts';

// The connection string (it holds a password) comes through the environment, never argv.
const connectionString = process.env.GM_TEST_CONNECTION;
const [lockName] = process.argv.slice(2);
const election = new LeaderElection({
  connectionString: connectionString as string,
  lockName: lockName as string,
  intervalMs: 200,
  log: createLogger({ level: 'silent' }),
  onElected: () => {
    process.stdout.write('ELECTED\n');
  },
  onLost: () => {
    process.stdout.write('LOST\n');
  },
});
await election.start();
process.stdout.write('STARTED\n');
process.once('SIGTERM', () => {
  election.stop().then(() => process.exit(0));
});
setInterval(() => undefined, 1000);
