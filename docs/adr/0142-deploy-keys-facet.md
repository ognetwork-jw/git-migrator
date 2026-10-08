# ADR-0142: deploy-keys facet semantics

- Status: accepted (no spec change needed)
- Date: 2026-10-08
- Task: T-053
- Affects: FAC-DKY-001, FAC-DKY-002, FAC-DKY-003

## Decision

- **Pre-detection input.** `ctx.routeIndex.deployKeyUsage` is a plain `Record<publicKey, number>`: the number of source repositories on the Route (from stored Snapshots) that carry the key, this one included. A count above one raises post task `deploy-keys.key-in-use` with params `{ keyName, publicKey }` at `/keys[publicKey=…]`. The apply step records the same params when the target rejects a key, so the two reports deduplicate by `paramsHash`. The key stays in `desired`. Absent data raises nothing; malformed data throws. Maps and Sets are rejected by the engine (ADR-0140).
- **`keyName`** is the title, or `deploy-key` when the title is blank (the guidance copy snippet needs a name).
- **Read-only.** Keys are always created read-only (FAC-DKY-002), so `desired.readOnly` is `true`; a source key that is writable gets a `translated` decision. Bitbucket keys are all read-only (FAC-DKY-001), so this is a safeguard.
- **Completion.** `key-in-use` is satisfied when the target holds the same public key (the guidance verification text).
- **Compare** is the structural diff over `publicKey`, `title` and `readOnly`.

## Alternatives

- Fail the key (blocker) when the count is above one: the target may still accept it, and FAC-DKY-002 says to continue.
