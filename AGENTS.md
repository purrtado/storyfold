# Storyfold Agent Guide

## Repo Hygiene
- Maintain this file; propose additions or modifications to the user if you believe future agents can benefit from it.

## Git Rules
- Branches should have a prefix `ui/` for frontend changes, `server/` for backend changes, `app/` for changes that touch both.
- Commits follow conventional format
- PR titles are the conventional squash title; PR bodies use `.github/PULL_REQUEST_TEMPLATE.md`

## Code conventions
- JSON API is snake_case with ISO timestamps

## Tech Stack
- UI: React + TypeScript
- Frontend tooling: Vite
- Styling: Tailwind CSS
- UI Primatives: shadcn/ui
- Tooling/runtime: Bun
