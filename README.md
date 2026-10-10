# Storyfold

Storyfold is a local-only chat interface prototype built with React, TypeScript, Vite, Tailwind CSS, and Bun. It has no backend or API and does not generate AI replies.

## Getting started

Install [Bun](https://bun.sh), then run:

```sh
bun install
bun run dev
```

Vite prints the local URL in the terminal.

Create a production build with:

```sh
bun run build
```

Type-check without building:

```sh
bun run typecheck
```

## Interface

- Start new conversations, switch between existing ones, and browse sample conversations with clearly-marked sample replies rendered as Markdown (headings, lists, code blocks, tables).
- On first visit you land on an empty conversation with starter prompts that fill the composer; samples stay in the sidebar.
- Conversations and submitted messages are saved in browser localStorage on this device; nothing is sent to a server, and no AI replies are generated.
- Switch between light and dark themes (sidebar or header toggle); the selected theme is saved in browser localStorage.
- Collapse the sidebar on desktop; on mobile it becomes a slide-in drawer.
- Press Enter to send a message or Shift+Enter for a newline.