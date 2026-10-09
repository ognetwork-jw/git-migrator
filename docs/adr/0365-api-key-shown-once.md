# ADR-0365: An issued API key lives only in the one-time dialog's state

- Status: accepted (spec updated)
- Date: 2026-10-09
- Task: T-091
- Affects: UI-034, API-020, AUTH-040, AUTH-022

## Context

`POST /actors/{id}/api-keys` returns the full key once (API-020). T-091's acceptance: API keys are shown once. The client has a query cache, a mutation cache and browser storage, and each keeps data after a component unmounts unless told not to. A mutation hook returns its result into the mutation cache.

## Decision

- The key is requested with a plain `apiRequest` call inside an event handler. The answer is held in the component's `useState` only. No query key, mutation hook result, Context, URL or browser storage receives it.
- The dialog shows the key in a read-only field with a copy button and a warning that it cannot be shown again. The key is not shown in the list, which shows only the public prefix.
- Closing the dialog unmounts it (`destroyOnHidden` and the parent's `issuing` flag), so the key leaves the React tree. The keys list is refetched, which never contains the full key.
- The client logs nothing. Tests check the query cache, the mutation cache, `localStorage`, `sessionStorage`, `console` calls and the request URLs for the key.

## Alternatives

- `useMutation` with the key in its result: the mutation cache would keep the key until garbage collection (five minutes by default). Rejected.
- Show the key on the list row after issue: it would stay in the list state. Rejected.
