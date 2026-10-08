import { loadConfigOrExit } from '@git-migrator/config';
import { runMigrate, runReset, runSeed } from './db-commands.ts';

// Entry for `pnpm db:migrate`, `db:seed` and `db:reset --yes`. It runs under plain `node`, so every
// module it imports must use erasable TypeScript syntax only. Secrets (POSTGRES_PASSWORD) come from
// the environment, which `secretspec run` fills; nothing is printed but counts.
const commands = { migrate: runMigrate, seed: runSeed, reset: runReset } as const;
const name = process.argv[2];
const command = commands[name as keyof typeof commands];
if (!command) {
  process.stderr.write(`usage: db-cli <${Object.keys(commands).join('|')}> [--yes]\n`);
  process.exit(64);
}
if (name === 'reset' && !process.argv.includes('--yes')) {
  process.stderr.write('db:reset drops the configured database; run it as `pnpm db:reset --yes`\n');
  process.exit(64);
}
const result = await command(loadConfigOrExit(), process.env);
process.stdout.write(`${name}: ${JSON.stringify(result)}\n`);
// The pools are closed by the commands; exit explicitly so a stray handle cannot hang the process.
process.exit(0);
