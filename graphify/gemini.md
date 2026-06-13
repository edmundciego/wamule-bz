# Wamule AI Guidelines

This file provides detailed operational guidelines for AI assistants working on the Wamule codebase. Please consult the root `GEMINI.md` file first for overall project interaction rules and documentation mapping.

## Interaction Conventions
- **Architectural Integrity:** All code changes must align with the architecture documented in `graphify/`.
- **Database First:** Any change affecting data structures must start with a corresponding migration in `supabase/migrations/` and an update to `src/types/database.ts`.
- **Testing:** New features MUST include corresponding tests (use existing testing patterns if available).
- **Documentation:** If a significant architectural change is made, update the relevant file in `graphify/`.
- **Supabase Usage:** Use only the established Supabase client initialized in `src/lib/supabase.ts`. Do not introduce raw fetch calls or alternative clients.
- **Styling:** Adhere strictly to the Tailwind/Shadcn UI implementation style.
