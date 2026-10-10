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

## Interface

- Start new conversations, switch between existing ones, and browse sample conversations with Markdown-formatted sample replies.
- Conversations and submitted messages are saved in browser localStorage on this device; nothing is sent to a server, and no AI replies are generated.
- Switch between light and dark themes; the selected theme is saved in browser localStorage.
- Press Enter to send a message or Shift+Enter for a newline.
- Use the responsive conversation drawer on mobile.