# ADR-0504: A Route retargeted after the framework wrote its target

- Status: agent-decided
- Date: 2026-10-10
- Task: T-097
- Affects: LIF-011, LIF-005, LIF-031, LIF-060, LIF-077, LIF-080, DOM-010

## Context

A config sync (LIF-011) may change a Route's target Endpoint or Namespace after the framework wrote the target. On the GitHub target one Endpoint is one organization, so a retarget there is an Endpoint change. `syncConfig` then clears the Route's resolved Namespace, and every later Run worked in the new place:
- **Repository Migrations.** A resync looked the old target repository up by its id in the new Namespace and found nothing. It created a second repository there and claimed it. A rollback then deleted the new repository and marked every remaining target record undone, including the creation of the old repository, which stayed on the target with whatever was pushed to it.
- **Endpoint Migrations.** These have no target repository: they write teams, variables and hooks to the target Namespace. They were neither guarded nor rolled back in the right place. A rollback looked the teams up in the new organization, found nothing, and marked them undone.

The spec says nothing about Migrations whose target belongs to an earlier Route target.

## Decision

1. **The pinned place.** `Migration.targetPlacedEndpointId` and `targetPlacedNamespaceId` record where the framework writes the target.
   - The first Step of a `migrate`, `run_anyway` or `resync` Run pins the Route's current place when nothing is pinned (`checkPlacement`, `packages/jobs/src/run/placement.ts`). This happens before any target write, for repository and endpoint Migrations alike, so an open create intent or a recorded creation with no linked repository is covered too.
   - A pin counts only while there is something to protect: a target repository, or target writes not undone (an open intent included; adopted state and no-ops do not count). A Run that failed before its first write, for example in preflight against a wrongly configured organization, leaves a pin that protects nothing. Once the Route is corrected, that pin is ignored and the next writing Step pins again, so the Migration is never stuck behind a place where nothing was written.
   - A completed rollback clears the pin.
   - For a Migration written before the pin existed, the target repository's place stands in, and the database migration backfills the pin from that evidence only.
   - **Legacy writes of unknown place.** A Migration with target writes but no target repository, such as an endpoint Migration or a creation never linked, may have been retargeted since. Its place is unknown, so the pin stays empty and `targetPlacementUnknown` is set.
     - The Analysis raises the blocker `repository-settings.target-placement-unknown` (with guidance).
     - Every Run that works on the target (`migrate`, `run_anyway`, `resync`, `verify`) and the rollback is refused with `run.confirmation_required` until the operator confirms that the writes went where the Route points now. They type the target full name in the Route's Namespace (the same name a rollback confirms, LIF-077 and LIF-043), or the Namespace path for an endpoint Migration, which has no target name. The web UI offers this as a typed-name dialog for every such Run while the flag is set, on the repository detail page and the endpoint migration page; a refusal names what to type. The repositories list offers no quick Run for such a Migration, and a bulk migrate skips it, since neither can ask for the name. The confirmation also answers the blocker, so the Run is admitted past it.
     - The confirmation pins the Route's place in the admitting transaction, for every kind, the rollback included, so a Route retargeted while the Run waits changes nothing. A Run other than a rollback also clears the flag. A rollback keeps the flag until it completes, when the pin and the flag are cleared; a failed rollback keeps both. The Route's target Namespace must be resolved to confirm. A Parity Check or drift check of such a Migration is skipped with `target-placement-unknown`, and completes no task.
     - A Step never pins while the flag is set: it fails with the same code, so a Run queued or resumed past the guard cannot write the new place.
     - If the writes went elsewhere, the operator restores the Route's target, rolls back, then changes the Route.
     - The framework does not guess, and never marks records undone in a place it cannot vouch for. This is a known limit for data written before T-097.
2. **Placement.** A Migration's target is *outside its Route* when its pinned place's Endpoint differs from the Route's target Endpoint, or its Namespace differs from the Route's resolved target Namespace. While the new Namespace is not resolved yet, the configured path is compared with the pinned Namespace's slug or key, ignoring case, as inventory resolves it (`targetOutsideRoute`).
3. **Guard.** `createRun` refuses `migrate`, `run_anyway`, `resync` and `verify` for a Migration whose target is outside its Route, with `run.not_permitted` (409). The message names the target and the way out. Rollback and the source lock Runs stay available. `verify` is refused because it would read the new place instead of the target: this is a placement check, not a readiness gate, so it does not contradict LIF-005's "not gated by readiness or blockers".
4. **Blocker.** The Analysis raises the blocker `repository-settings.target-outside-route` for both scopes, with guidance naming the old Namespace. Readiness is then `blocked`, and the UI says what to do. The Analysis does not look the old target repository up in the new Namespace. A queued Run re-analyzes inline first and is cancelled with `readiness_changed` (LIF-022).
5. **Step check.** A Run admitted before the change and resumed after it (its pre-run Analysis already done) fails its first Step with `repository-settings.target-outside-route`, before it touches the new place. This holds in the repository and endpoint world loaders alike.
6. **Parity.** A Parity Check (`verify` or a scheduled drift check) of a Migration whose target is outside its Route is skipped with the reason `target-outside-route`. Otherwise it would read the new place and report every Facet as missing on the target.
7. **Rollback where the writes went.**
   - A repository Migration's rollback connects to its target repository's own Endpoint and works in that repository's Namespace.
   - An endpoint Migration's rollback works on the pinned Endpoint and Namespace, never the Route's, so a team is looked up in the organization it was created in. A record is never marked undone because a lookup in the wrong organization found nothing.
   - The guard refuses a rollback, before anything is deleted, when any Endpoint it will touch is missing or retired, and names that Endpoint. Those Endpoints are the pinned one and each one named by a repository creation not undone.
   - When the rollback completes, an adopted target repository that is outside the Route is released, so the next Analysis plans the target in the new place.
   - The typed confirmation names the target where it is: the target repository's full name, or, for a target known only from the ledger, the planned name in the pinned Namespace, not in the Route's new one.
8. **Earlier repositories after a deletion.**
   - **Lookup.** When the rollback deletes the Migration's own target, a recorded creation of another repository (an earlier Run's) is checked by provider id, as on an adopted target. The check runs on the Endpoint the creation record names (records now carry `endpointId`) or, for older records, the Endpoint its `Repository` row names.
   - **Unknown Endpoint.** When neither says which Endpoint, the Run fails with `rollback.endpoint-unknown` and the precise reason. It does not ask the target's Endpoint, which could answer "not found" for a repository that lives elsewhere.
   - **Still there.** A repository that still exists is left and reported in the `left-in-place` post task (`repository-earlier`). Its creation stays recorded, together with the records written between its creation and the deleted target's creation, which went to it. The Run fails `rollback.left-in-place` until the repository is gone.
   - **Gone.** A repository the provider says is gone is undone with the rest.

## Alternatives

- **Follow the Route:** let a resync move the Migration to the new place automatically. It would orphan or duplicate data the framework created, and LIF-077 deletes only what the ledger proves.
- **Record the Endpoint and Namespace on every ledger row.** This is the most precise option, but it changes every record the drivers write. One place per Migration is enough: the guard keeps a Migration from writing to two places, and repository creation records name their Endpoint for the one case that spans places.
- **Refuse rollback for a target on another Endpoint.** It would leave the operator no way to remove what the framework created except restoring the old configuration.

## Affected requirements

LIF-011 (effects of a config change), LIF-005 and DOM-010 (Run admission), LIF-031 (target blockers), LIF-060 (Parity Checks), LIF-077 (rollback), LIF-080 (endpoint Migrations).
