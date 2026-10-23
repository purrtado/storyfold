# Storyfold Agent Guide

## Repo Hygiene
- Maintain this file; propose additions or modifications to the user if you believe future agents can benefit from it.

## Git Rules
- Branches should have a prefix `ui/` for frontend changes, `server/` for backend changes, `app/` for changes that touch both.
- Commits follow conventional format
- PR titles are the conventional squash title; PR bodies use `.github/PULL_REQUEST_TEMPLATE.md`
- For visual UI changes, capture current screenshots and attach them with `gh pr edit <number> --attach './screenshot.png#Descriptive alt text'`; repeat `--attach` for multiple images. To place them in the PR's Screenshots section, use local Markdown image references in `--body-file` and attach those same paths; `gh` uploads the files and rewrites the references. Do not commit screenshot files solely for PR attachments.
- Stacked PRs target the previous PR's branch. CodeRabbit only auto-reviews PRs targeting `main`, so comment `@coderabbitai review` on each stacked PR.

## Code conventions
- JSON API is snake_case with ISO timestamps

## Tech Stack
- UI: React + TypeScript
- Frontend tooling: Vite
- Styling: Tailwind CSS
- UI Primatives: shadcn/ui
- Tooling/runtime: Bun
