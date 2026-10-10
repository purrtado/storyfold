# Storyfold

Storyfold is a local-only chat interface prototype built with React, TypeScript, Vite, Tailwind CSS, and Bun. It has no backend or API and does not generate AI replies.

## Getting started

Install [Bun](https://bun.sh), then run:

```sh
bun install
bun run dev
```

Vite prints the local URL in the terminal.

To access the dev server from another device, run `bun run dev -- --host` and open Vite's Network URL. LAN HTTP is not a secure context, so id generation falls back to `crypto.getRandomValues` when `crypto.randomUUID` is unavailable.

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
- Theme defaults to System and follows browser/OS light/dark changes live; explicitly picking Light or Dark overrides System until you switch back (saved in browser localStorage).
- Collapse the sidebar on desktop to a narrow icon rail (preference saved); on mobile it remains a slide-in drawer.
- Press Enter to send a message or Shift+Enter for a newline. The composer grows with multiline text; the send button stays aligned to its bottom edge.
- The transcript keeps new messages in view while you are near the bottom and hands scrolling back to you the moment you scroll up to read.

## UI components

The composer, transcript scroller, and tooltips are adapted from [beUI](https://beui.dev) registry sources (installed by copying and trimming the component code, not via the shadcn CLI):

- [Prompt Input](https://beui.dev/components/agents/prompt-input) — composer form, keyboard submission with IME safety, and send-button motion. Model/attachment/stop UI is omitted because this app has no backend; auto-grow uses the repo's `field-sizing` CSS instead of the registry's measurement mirror, so browsers without `field-sizing` show a fixed-height scrolling composer.
- [Message Scroller](https://beui.dev/components/agents/message-scroller) — reader-aware transcript viewport. Deviations: viewport resizes (composer growth, mobile drawer) re-align the live edge instantly while you are following, wheel, touch, and upward keyboard scrolling interrupt an in-flight follow, and the optional message navigation rail is omitted.
- [Tooltip](https://beui.dev/components/motion/tooltip) — hover/focus tooltips on the sidebar rail and theme control.

Dependencies added for these components: `motion` (reduced-motion-aware animation), `@floating-ui/dom` (tooltip positioning), `lucide-react` (send icon), and `clsx` + `tailwind-merge` (the `cn` class helper).