import { loadConfigOrExit } from '@git-migrator/config';
import { runMigrate } from './db-commands.ts';

// The `migrate` entrypoint (DEP-002): runs every DATA-030 step in order and exits non-zero on the
// first failure, so the Helm hook Job fails and the release stops. Secrets (POSTGRES_PASSWORD)
// come from the environment, which `secretspec run` fills; only counts are printed.
try {
  const result = await runMigrate(loadConfigOrExit(), process.env);
  process.stdout.write(`migrate: ${JSON.stringify(result)}\n`);
  process.exit(0);
} catch (error) {
  process.stderr.write(
    `migrate failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
