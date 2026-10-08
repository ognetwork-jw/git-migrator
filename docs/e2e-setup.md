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

1. Copy `testing/e2e/live/config.e2e.example.yaml` to `testing/e2e/live/config.e2e.yaml`.
2. Fill in the workspace, project key, org, App ID and Installation ID.
3. Store the secrets under secretspec profile `e2e` (keyring or dotenv):
   ```sh
   secretspec set BITBUCKET_CREDENTIALS --profile e2e   # [{"id":"e2e","accountId":"…","email":"…","apiToken":"…"}]
   secretspec set GITHUB_APP_PRIVATE_KEY --profile e2e  # PEM contents
   secretspec set POSTGRES_PASSWORD --profile e2e
   secretspec set BETTER_AUTH_SECRET --profile e2e
   secretspec set ENTRA_CLIENT_ID --profile e2e         # any placeholder unless running the Entra smoke test
   secretspec set ENTRA_CLIENT_SECRET --profile e2e     # same
   secretspec set GM_TEST_USER_PASSWORD --profile e2e
   ```
4. Start Postgres (`devenv up postgres` or `docker compose up -d postgres`).

## 4. Run

```sh
pnpm e2e:live:reset        # safe to run anytime; restores the starting state
pnpm test:e2e:live
```

The test first checks every precondition above (TST-031) and stops with a specific message if one fails. If `e2e-auto-ok` is not classified **Ready**, the test prints the readiness findings, which usually point straight at a fixture deviation (for example, a workspace group with default access).

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
