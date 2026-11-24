# CommitteeApp

A committee financial accountability, project, Pooja/ritual, inventory and
reporting application, built as a single installable Progressive Web App
(PWA).

> **Status: Phase 2D -- Supabase Auth + RBAC + RLS Authorization
> Boundary.** Phases 1 (app shell), 2A (PostgreSQL schema), and 2B
> (Financial Effect Engine RPC) are complete. This phase adds real RLS
> policies on all 20 tables, four-role authorization
> (`MEMBER`/`ACCOUNTANT`/`ADMIN`/`AUDITOR`), and corrects
> `financial_post_transaction()` to use `auth.uid()` as the sole
> authoritative actor identity -- a client can no longer attribute a
> transaction to another user. **The full approval workflow (submit →
> pending → approve), a dedicated account-provisioning RPC, project
> closure/clone execution, and all
> application UI are NOT implemented yet** -- see
> [`docs/ARCHITECTURE-GUARDRAILS.md`](docs/ARCHITECTURE-GUARDRAILS.md)
> before adding anything beyond the current phase.

## Tech stack

| Layer                | Choice                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Application model    | Progressive Web App (installable, one codebase for Android/iOS/desktop)                                          |
| Frontend             | React 19 + TypeScript (strict mode)                                                                              |
| Build tool           | Vite                                                                                                             |
| Backend platform     | Supabase (PostgreSQL + Auth + RLS + Storage) -- schema defined (Phase 2A); RPC layer/auth flows not yet wired up |
| Database schema      | 20 entities in `supabase/migrations/` -- structural only, no financial engine yet                                |
| Local/client storage | IndexedDB -- non-authoritative cache/drafts only (not yet used)                                                  |
| Linting              | ESLint (flat config) + `typescript-eslint` + `eslint-plugin-jsx-a11y`                                            |
| Formatting           | Prettier                                                                                                         |
| Testing              | Vitest + React Testing Library (app) / Vitest + PGlite (database schema)                                         |

This stack mirrors the canonical architecture document exactly; nothing
here was chosen ad hoc. See `docs/ARCHITECTURE-GUARDRAILS.md` for the
non-negotiable rules that follow from it.

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in your own Supabase project values
npm run dev
```

The app runs and builds correctly even without a real Supabase project
configured -- see [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for details.

## Available scripts

| Script                 | Purpose                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `npm run dev`          | Start the Vite dev server                                                                       |
| `npm run build`        | Type-check (`tsc -b`) and produce a production build, including the PWA manifest/service worker |
| `npm run preview`      | Serve the production build locally                                                              |
| `npm run typecheck`    | Type-check only, no build output                                                                |
| `npm run lint`         | Run ESLint                                                                                      |
| `npm run lint:fix`     | Run ESLint with `--fix`                                                                         |
| `npm run format`       | Run Prettier and write changes                                                                  |
| `npm run format:check` | Check formatting without writing                                                                |
| `npm test`             | Run the app (React/UI) test suite once (CI mode)                                                |
| `npm run test:watch`   | Run the app test suite in watch mode                                                            |
| `npm run test:db`      | Run the database/schema test suite (Phase 2A+) against an embedded PostgreSQL instance          |
| `npm run test:all`     | Run both the app test suite and the database/schema test suite                                  |

## Database (Phase 2A+)

The Supabase/PostgreSQL schema lives in `supabase/migrations/`. See
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md#database-phase-2a) for how
to apply migrations locally and run the schema test suite.

**The financial RPC layer, `FinancialEffectEngine`, and RLS
authorization policies are not implemented yet** -- Phase 2A is schema
only. See [`docs/ARCHITECTURE-GUARDRAILS.md`](docs/ARCHITECTURE-GUARDRAILS.md).

## Project structure

```
src/
  app/                  Application shell (App.tsx and its styles/tests)
  shared/
    config/              Typed environment configuration (env.ts)
    lib/supabase/         Supabase client foundation (session/auth only --
                          see the guardrail comment in client.ts)
    styles/               Design tokens (tokens.css) and global base styles
    testing/               Vitest setup (jest-dom matchers, RTL cleanup)
  main.tsx                 Entry point
  vite-env.d.ts             Typed import.meta.env
supabase/
  migrations/               Ordered, numbered PostgreSQL migrations (Phase 2A schema)
  tests/
    helpers/                 Migration-runner test helper (PGlite)
    schema/                   Schema/constraint/immutability test suites
docs/
  DEVELOPMENT.md            How to run, test and extend this project
  ARCHITECTURE-GUARDRAILS.md  Non-negotiable rules derived from the architecture doc
```

## Further reading

- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) -- day-to-day development workflow
- [`docs/ARCHITECTURE-GUARDRAILS.md`](docs/ARCHITECTURE-GUARDRAILS.md) -- rules every future phase must follow
