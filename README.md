# Storyfold

Storyfold is a local, single-user chat app built with React, TypeScript, Vite, Tailwind CSS, and Bun. A local Bun server stores Z.AI provider configuration and streams assistant replies using TanStack AI.

## Getting started

Install [Bun](https://bun.sh), then run:

```sh
bun install
bun run dev
```

`bun run dev` starts the API at `http://127.0.0.1:7834` and Vite at `http://127.0.0.1:5173`. Vite proxies `/api` to the API. Both bind to loopback by default.

To use another backend port, run `STORYFOLD_PORT=7835 bun run dev`. The server and Vite proxy share this override. Frontend ports are fixed at 5173 (development) and 4173 (preview).

For testing from another machine on a trusted local network, run:

```sh
bun run dev --host
```

Open `http://<server-LAN-IP>:5173` on that machine. You can also bind Vite to a specific interface with `bun run dev --host <server-LAN-IP>`. The backend remains on loopback; Settings and chat go through Vite's proxy, and frontend origins on this machine's interface IP addresses are accepted on ports 5173 and 4173.

LAN access is unauthenticated: anyone who can reach Vite can change provider settings or use the saved API key for inference. Use it only on a trusted network; do not expose the app publicly.

Create a production build with:

```sh
bun run build
```

Type-check without building:

```sh
bun run typecheck
```

Run server regression tests with `bun test`. To exercise a production build locally, run `bun run server` and `bun run preview` in separate terminals after building. Set the same `STORYFOLD_PORT` in both terminals if overriding it.

## Provider setup

Open **Settings → Providers** (`/settings/providers`):

1. Enter your Z.AI API key.
2. Choose a **Default model** from the curated dropdown: `GLM-5.3` (default) or `GLM-5.3 Flash` — the two models documented for every GLM Coding Plan tier ([model overview](https://docs.z.ai/devpack/overview)).
3. Save, return to chat, and send a message.

Requests use the fixed Coding Plan endpoint `https://api.z.ai/api/coding/paas/v4/chat/completions`; there is no fallback to the separately billed general API. Z.AI's [Coding Plan usage policy](https://docs.z.ai/devpack/usage-policy) restricts subscription use to officially supported tools and products; verify eligibility for your use.

Configuration belongs to this local installation, not a user account. The server saves it at `$XDG_CONFIG_HOME/storyfold/config.json`, or `~/.config/storyfold/config.json` when an absolute XDG path is not configured. The directory is created with mode `0700`, and the file with mode `0600`; the API key is stored in plaintext, protected by your OS user permissions, not encryption.

The saved key is never returned to the browser or stored in browser localStorage. Leave the key field blank when changing the model to retain the existing key, enter a new key to replace it, or use **Remove configuration** to delete the saved setup. Saving validates configuration locally; sending a message exercises the provider.

The API accepts only loopback backend Host headers and frontend origins on localhost or this machine's interface IP addresses, requires JSON for chat/configuration bodies, and bounds request sizes. These safeguards reject unrelated browser origins and DNS rebinding; they do not authenticate LAN clients or other processes running as your OS user.

## Interface

- Start new conversations, switch between existing ones, and browse sample conversations with clearly-marked sample replies rendered as Markdown (headings, lists, code blocks, tables).
- On first visit you land on an empty conversation with starter prompts that fill the composer; their concise labels are centered, and samples stay in the sidebar.
- Conversations are saved in browser localStorage. Sending a message forwards the active conversation history through the local server to Z.AI, including sample messages if continuing a sample conversation.
- Open Settings from the User menu at the bottom of the sidebar or compact rail. General lives at `/settings/general`, with System / Light / Dark theme choices; Providers lives at `/settings/providers`. Back to app returns to your conversation without clearing its draft.
- Theme defaults to System and follows browser/OS light/dark changes live; explicitly picking Light or Dark overrides System until you switch back (saved in browser localStorage). The User avatar is a display-only placeholder, not an account.
- Collapse the sidebar on desktop to a narrow icon rail (preference saved); its logo toggles expansion, with the sidebar icon revealed on hover or keyboard focus. The rail adapts per page: chat shows new-conversation, settings shows Back to app, General, and Providers. On mobile it remains a slide-in drawer. Expanding lays the full sidebar out at its resting width inside the clipped shell and reveals it, so its labels never re-wrap mid-animation.
- Press Enter to send a message or Shift+Enter for a newline. The composer's model picker offers the Settings Default model; an explicit choice applies to that message, is kept in memory for the conversation, and never rewrites the saved Default — a sending message captures its model, so later picker changes cannot alter an in-flight reply. Replies stream from the provider through TanStack AI into the transcript. Stop cancels generation and keeps partial text; failures preserve your message and any partial reply. One response can generate at a time, and it remains attached to its originating conversation when switching chats or opening Settings.
- The transcript keeps new messages in view while you are near the bottom and hands scrolling back to you the moment you scroll up to read.

Settings uses browser-history routes. Production hosting must serve `index.html` for application URLs such as `/settings/general` so direct links and refreshes work (Vite dev/preview already handle this).

## UI components

The composer, transcript scroller, tooltips, and theme indicator are adapted from [beUI](https://beui.dev) registry sources (installed by copying and trimming the component code, not via the shadcn CLI):

- [Prompt Input](https://beui.dev/components/agents/prompt-input) — composer form, keyboard submission with IME safety, send-button motion, and a Stop control during generation. The model picker offers the provider Default with an optional per-message override; attachment UI is omitted. Auto-grow uses the repo's `field-sizing` CSS instead of the registry's measurement mirror, so browsers without `field-sizing` show a fixed-height scrolling composer. Focus uses the existing rounded composer border; forced-colors mode retains a visible textarea outline.
- [Message Scroller](https://beui.dev/components/agents/message-scroller) — reader-aware transcript viewport. Deviations: viewport resizes (composer growth, mobile drawer) re-align the live edge instantly while you are following, wheel, touch, and upward keyboard scrolling interrupt an in-flight follow, and the optional message navigation rail is omitted.
- [Tooltip](https://beui.dev/components/motion/tooltip) — hover/focus tooltips on the sidebar rail.
- [Tabs](https://beui.dev/components/motion/tabs) — shared-layout spring indicator adapted to the settings theme radios, without tab panels or overflow controls. The pill slides between choices; reduced-motion users get an instant selection change.

Dependencies added for these components: `motion` (reduced-motion-aware animation), `@floating-ui/dom` (tooltip positioning), `lucide-react` (send icon), and `clsx` + `tailwind-merge` (the `cn` class helper).

The User menu uses Radix Dropdown Menu; page navigation uses React Router. Settings theme choices use native radios for keyboard navigation and accessible selection.