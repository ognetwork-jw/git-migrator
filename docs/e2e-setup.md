# Live e2e setup (human)

These are the one-time steps to prepare real Bitbucket and GitHub test accounts, so you can run the live Phase-1 e2e test (TST-030). Use **dedicated** test accounts and organizations. The test creates and deletes GitHub repositories, and locks and unlocks the Bitbucket fixture.

## 1. Bitbucket Cloud

1. Create or choose a test **workspace** on the **Standard** plan, for example `gm-e2e`.
2. Create a project with key `E2E`.
3. Create the repository **`e2e-auto-ok`** in project `E2E`, then populate it:

   | Item | Required state |
   |---|---|
   | Visibility | Private |
   | Description | `git-migrator e2e fixture` |
   | Website | `https://example.com/e2e` |
   | Forking | "Allow only private forks" |
   | Branches | `main` (default), `develop`, `feature/one`, each with at least one distinct commit |
   | Tags | `v1.0.0` (annotated) and `v1.0.1` (lightweight) |
   | LFS | `.gitattributes` tracking `*.bin`, and one committed `assets/sample.bin` of about 1 MB |
   | Branch restrictions | On `main`: "Prevent rewriting history" (force push) and "Prevent deleting this branch". No user or group lists. No merge checks. |
   | Access keys | One SSH public key, titled `e2e-key`, not used anywhere else on Bitbucket or GitHub |
   | Repository variables (Pipelines) | `E2E_VAR=hello` (unsecured). **No** secured variables. |
   | Pipelines | **No** `bitbucket-pipelines.yml` |
   | Webhooks | None |
   | Pull requests | None open |
   | Permissions | No explicit user or group permissions. Workspace groups must **not** grant default access to this repository. |

4. Create a user-scoped **API token** for a workspace admin account, with the scopes listed in [providers/bitbucket-cloud](providers/bitbucket-cloud.md#authentication). Note the account's Atlassian **account ID** (shown in the profile URL).

## 2. GitHub

1. Create or choose a test **organization** on the **Team** plan, for example `gm-e2e-org`.
2. Create a **GitHub App** owned by that org with the permissions in [providers/github](providers/github.md#required-app-permissions). Disable webhooks for the App. Generate a private key.
3. Install the App on the org with access to **All repositories**. Note the **App ID** and **Installation ID**.
4. Ensure no repository named `e2e-e2e-auto-ok` exists. That is the planned name `{e2e}-{e2e-auto-ok}`.
5. Org settings: allow repository deletion by the App (for reset), and allow private repository forking.

## 3. Local configuration

1. Copy `testing/e2e/live/config.e2e.example.yaml` to `testing/e2e/live/config.e2e.yaml` (git-ignored).
2. Fill in the workspace, the org, the App ID and the Installation ID, and replace every `<placeholder>`. Leave `environment: e2e` and `auth.testSignIn.enabled: true`. `publicUrl` must stay `http://127.0.0.1:<port>`: the test starts the web app there, so the port must be free. The project key (`E2E`) and the repository name (`e2e-auto-ok`) are fixed by this guide and are not configuration.
3. Store the secrets under secretspec profile `e2e` (keyring or dotenv):
   ```sh
   secretspec set BITBUCKET_CREDENTIALS --profile e2e   # [{"id":"e2e","accountId":"…","email":"…","apiToken":"…"}]
   secretspec set GITHUB_APP_PRIVATE_KEY --profile e2e  # PEM contents
   secretspec set POSTGRES_PASSWORD --profile e2e       # the password of the local `git_migrator` Postgres role
   secretspec set BETTER_AUTH_SECRET --profile e2e
   secretspec set ENTRA_CLIENT_ID --profile e2e         # any placeholder unless running the Entra smoke test
   secretspec set ENTRA_CLIENT_SECRET --profile e2e     # same
   secretspec set GM_TEST_USER_PASSWORD --profile e2e   # the test sign-in password of the seeded Actors
   ```
4. Start Postgres (`devenv up postgres` or `docker compose up -d postgres`). The test creates and drops its own throw-away database in it, as role `git_migrator` on `127.0.0.1:5432` with `POSTGRES_PASSWORD`. Set `GM_TEST_DATABASE_URL` to use another server or role.

## 4. Run

```sh
pnpm e2e:live:reset        # restores the starting state after a run
pnpm test:e2e:live
```

`pnpm test:e2e:live` builds the web app, then runs Playwright under `secretspec run --profile e2e` with `GM_E2E_TARGET=live` and `GM_CONFIG_FILE=live/config.e2e.yaml` (relative to `testing/e2e`, so the file you copied in section 3; set `GM_CONFIG_FILE` to use another file). The test starts the worker and the web app itself; do not run `pnpm dev` on the same port at the same time.

**It never runs in CI.** It refuses to start when `CI`, `GITHUB_ACTIONS` or a similar variable is set, when `GM_ENVIRONMENT` is not `e2e`, when the configuration is missing, still holds placeholders or points at a local address, or when a secret is missing. Every reason is printed with the command that fixes it. CI runs the same spec in a dry mode against the provider fakes (`GM_E2E_TARGET=fakes`, `pnpm test:e2e:live:dry`) to keep it type-checked and working.

**`GM_CONFIG_FILE`** may be absolute, relative to `testing/e2e`, or relative to the repository root; the test resolves it to an absolute path once and hands that path to the web app.

**Artefacts hold real secrets.** A live run writes the web and worker logs to `testing/e2e/live-artifacts/` and failure screenshots to `testing/e2e/live-artifacts/test-results/` (git-ignored, never uploaded by CI), not to the `logs/` and `test-results/` of the fakes tier. No Playwright trace is recorded, because a trace holds the sign-in password. The web log is raw Next.js output: read it before you share it, and delete the directory when you are done.

**Preconditions (TST-031).** Before it starts anything, the test reads both providers and stops with one message per unmet precondition, for example `Bitbucket repository e2e-auto-ok not found in project E2E` or `GitHub App lacks permission administration:write`. It checks:

- Bitbucket: the token is valid, belongs to the `accountId` in `BITBUCKET_CREDENTIALS` and is a workspace admin; the repository, its project, visibility, description, website, fork policy and default branch; the branches and tags; `.gitattributes` and `assets/sample.bin`; the branch restrictions on `main` (and none left on `*` by an earlier run); the access key; the variables; no pipelines file, webhooks, open pull requests or explicit permissions.
- GitHub: the App is installed on the org with access to all repositories, is not suspended, has the IDs from the configuration and every permission of [providers/github](providers/github.md#required-app-permissions); the org is on the Team plan; the target `e2e-e2e-auto-ok` does not exist yet.

Not checked by the test, so verify them by hand: that `v1.0.0` is an annotated tag and `v1.0.1` a lightweight one, that `assets/sample.bin` is about 1 MB, and that the org lets the App delete repositories (the reset reports a 403 if not).

If `e2e-auto-ok` is not classified **Ready**, the test prints the readiness findings, which usually point straight at a fixture deviation (for example, a workspace group with default access).

**After a run, reset before running again.** The test leaves the target repository and the read-only changes in place so you can look at them. `pnpm e2e:live:reset` (TST-032) deletes the target repository, removes the push restriction on `*` and the `[MIGRATED → …]` description prefix, and does nothing for what is already clean (running it twice is harmless). It prints the workspace, repository and organization first, deletes the target only if its description and homepage are the fixture's (otherwise it refuses and you delete it by hand), and still cleans the Bitbucket side if the GitHub side fails. If a running local app (`GM_E2E_APP_URL=http://127.0.0.1:3000`, local addresses only, signed in with `GM_TEST_USER_PASSWORD`) still has the Migration, it first uses the app's own `undo_source_read_only` and `rollback` Runs; otherwise, and for whatever is left, it calls the providers directly. It needs the App's `administration:write` and an org that lets the App delete repositories.

**What success means:**

- The repository appears in the unmigrated list as Ready.
- One click migrates it.
- The Run reaches Succeeded live.
- The status shows **Verified**.
- On GitHub `gm-e2e-org/e2e-e2e-auto-ok` exists with identical refs and tags, the LFS object, the description, homepage and forking setting, a protection rule on `main` (no force push, no deletion), the deploy key and the `E2E_VAR` variable.
- On Bitbucket the repository has a push restriction on `*` and a `[MIGRATED → …]` description prefix.

## 5. Optional: Entra sign-in smoke test

1. Create an Entra app registration with redirect URI `http://localhost:3000/api/auth/callback/microsoft`.
2. Define the app roles `GitMigrator.Admin`, `GitMigrator.Operator` and `GitMigrator.Viewer`, and assign yourself one.
3. Put the client ID and secret into secretspec, and the tenant ID into the config.
4. Set `auth.testSignIn.enabled: false`.
5. Run `pnpm dev`, then sign in through the button.
6. Expected: your role appears in the header. A user without a role assignment lands on `/denied`.
