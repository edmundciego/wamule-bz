# Wamule Development Project - AI Guidelines

Welcome. Please adhere to the following guidelines when working on this project to maintain architectural integrity and consistency.

## Documentation
All architectural, workflow, and data-flow documentation is maintained in the `/graphify` directory.

- **System Map:** `graphify/wamule-system-map.md`
- **Data Flow:** `graphify/wamule-data-flow.md`
- **Route Map:** `graphify/wamule-route-map.md`
- **Workflow Map:** `graphify/wamule-workflow-map.md`
- **Future Portal Map:** `graphify/wamule-future-portal-map.md`
- **AI Agent Personas:** `graphify/agents.md`
- **Project Guidelines:** `graphify/gemini.md`

## Interaction Rules
1. **Always Consult `/graphify`:** Before starting any new task, verify alignment with the documented architecture.
2. **Database Integrity:** Follow the "Database First" rule defined in `graphify/gemini.md` for any changes affecting schemas or migrations.
3. **Consistency:** Maintain the established styling (Tailwind/Shadcn UI) and API usage (Supabase client in `src/lib/supabase.ts`).
4. **Maintenance:** If a change impacts the project's structure or workflow, update the corresponding file in `/graphify`.
