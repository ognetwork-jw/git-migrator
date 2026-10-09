# ADR-0321: Server-side capability check for data pages

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-084
- Affects: AUTH-020, AUTH-021, UI-010, UI-027, UI-028
- Extends: ADR-0300

## Context

ADR-0300 gates sidebar items in the browser only (the shell redirects to `/denied`). That keeps the item hidden, but the page's server render and bundle are still delivered to a role that cannot use it. T-084's pages are the first that show data. The data itself comes only from `/api/v1`, which enforces roles, so a viewer who opens the page directly sees an error and no data; but the page should not render for them at all.

## Decision

- `apps/web/src/server/authorize.ts` exports `authorizePage(pathname)`, run by the server component of each gated page before it renders. It calls the API in process (`GET /api/v1/me`, the same Actor resolution as every request) with the incoming `cookie` and `authorization` headers and checks the Actor with the shared `can` helper. Not signed in redirects to `/signin?next=`; a missing capability redirects to `/denied?required=<role>`.
- The capability a page needs is the one its sidebar item names (`capabilityForPath`), so the table in `navigation.ts` stays the single source.
- The client-side redirect stays as the quick path; the server check is what protects the page. Pages added by later tasks use the same helper.

## Alternatives

- A Next.js middleware: it cannot reach the database or Better Auth in this setup.
- Checking in the shared layout: the layout does not know the pathname.
