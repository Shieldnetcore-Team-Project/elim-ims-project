# @elim/supabase-client

Typed Supabase client + auth session context for the future frontend. Deliberately minimal — no form components, no Shadcn/TanStack Query/Zod usage.

```ts
import { supabase, AuthProvider, useAuth } from "@elim/supabase-client";
```

Requires `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in the consuming app's env (see `supabase/config.toml` for local dev values after `supabase start`).

`src/database.types.ts` is generated, not hand-written — regenerate with `npm run gen-types -w supabase-client` once the local Supabase stack is running.

## What's deliberately not here yet

This package does not decide where a new frontend workspace lives, and does not include the Shadcn/TanStack Query/Zod/React Hook Form stack or any login/signup screens — the existing `client/` workspace runs React 18 with none of that installed, so standing up a new frontend is a separate decision, confirmed with the user before it happens, not bundled into this backend-foundation pass.
