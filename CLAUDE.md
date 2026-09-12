# HoldingsHub Development Project

## Environment
- This machine is LXC 223, `holdingshub-dev`.
- `/opt/holdingshub` is the DEVELOPMENT working repository.
- The application is a personal portfolio tracker built with Next.js 15, Supabase/Postgres and Tailwind.
- The application owner is not a professional software developer. Explain findings and proposed changes in clear language and do not assume deep software engineering knowledge.

## Critical Production Safety
- The local Supabase stack on this machine is the DEVELOPMENT database.
- Local development Supabase is available through localhost/172.16.20.223 and may be modified when development work requires it.
- The Supabase CLI is linked to the hosted `portfolio-tracker` project. Treat that hosted project as PRODUCTION.
- NEVER write to, reset, migrate, push schema changes to, or otherwise modify the linked/hosted production Supabase project unless the user explicitly authorises that specific production action.
- NEVER run destructive commands against the linked project, including `supabase db push`, a linked database reset, destructive SQL, or production data writes, without explicit approval.
- Do not copy development changes to production automatically.
- Never expose, print, commit, or copy secrets/API keys from `.env.local`.
- `.env.local` is development configuration and must remain uncommitted.
- Production HoldingsHub environments are outside the scope of normal development work and must not be modified without explicit approval.

## Current Development Baseline
- Git branch/checkpoint is based on `legacy-baseline-2026-09-11`.
- Local Supabase has been created from the production schema.
- A production DATA snapshot dated 2026-09-12 has been loaded into the local development database.
- Authentication has been configured locally and tested.
- Company logos have been tested and work locally.
- The local price streamer has been tested: Finnhub updates US prices and Yahoo updates non-US prices.
- Development helper scripts exist at:
  - `scripts/dev/dev-start.sh`
  - `scripts/dev/dev-stop.sh`
  - `scripts/dev/dev-status.sh`
- `dev-start.sh` has been tested successfully.
- A normal `npm run build` currently completes successfully, although there are existing Supabase/Edge Runtime warnings.

## Development Principles
- Understand existing behaviour before replacing it.
- Do not assume legacy code is wrong simply because it is old or untidy.
- Preserve working functionality unless a change has been agreed.
- Prefer small, understandable, testable changes.
- Do not make large-scale refactors without first proposing them.
- Do not silently change database semantics, transaction calculations, portfolio calculations, pricing behaviour or financial logic.
- Treat financial calculations and historical portfolio data as high-value logic requiring particular care.
- Before making significant changes, explain:
  1. what is wrong or could be improved,
  2. why it matters,
  3. what you propose,
  4. what could be affected.
- Use Git checkpoints for logical stages of work.
- Never commit secrets, production data dumps, `.env.local`, credentials or API keys.

## First Project Phase
The first substantial task will be a READ-ONLY audit of the existing HoldingsHub application.

During that audit:
- Inspect the application architecture, source code, scripts, configuration, Supabase schema/migrations and Git structure.
- Identify technical debt, duplicate/obsolete code, inconsistent patterns, security concerns and maintainability issues.
- Identify schema/code mismatches.
- Identify development/production assumptions embedded in the code.
- Review authentication and use of Supabase anon/service-role access.
- Review portfolio, transaction, cash, FX and pricing calculation architecture carefully.
- Review the live-price architecture and external provider dependencies.
- Investigate why the development application may not visually/behaviourally match the existing production application.
- Identify dependencies or old approaches that should eventually be modernised.
- Separate genuine defects from cosmetic/code-quality issues.
- Rank findings by risk and value.

The audit must NOT modify application code, database schema or data.

After the audit, produce a proposed phased improvement/rebase plan. Do not implement that plan until the user reviews and approves it.

## Communication
- Be concise but explain technical decisions in plain English.
- When several approaches exist, recommend one and explain why.
- Warn clearly before any action that could affect production or destroy data.
- Ask before crossing the development/production boundary.
