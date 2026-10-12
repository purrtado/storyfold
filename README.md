# Storyfold

Storyfold is a local, single-user interactive roleplay app built with React, TypeScript, Vite, Tailwind CSS, and Bun. A local Bun server persists worlds, personas, campaigns, and transcripts, and streams narrator replies from Z.AI using TanStack AI.

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
3. Save, return to the app, and start or resume a campaign.

Requests use the fixed Coding Plan endpoint `https://api.z.ai/api/coding/paas/v4/chat/completions`; there is no fallback to the separately billed general API. Z.AI's [Coding Plan usage policy](https://docs.z.ai/devpack/usage-policy) restricts subscription use to officially supported tools and products; verify eligibility for your use.

Configuration belongs to this local installation, not a user account. The server saves it at `$XDG_CONFIG_HOME/storyfold/config.json`, or `~/.config/storyfold/config.json` when an absolute XDG path is not configured. The directory is created with mode `0700`, and the file with mode `0600`; the API key is stored in plaintext, protected by your OS user permissions, not encryption.

The saved key is never returned to the browser or stored in browser localStorage. Leave the key field blank when changing the model to retain the existing key, enter a new key to replace it, or use **Remove configuration** to delete the saved setup. Saving validates configuration locally; sending a message exercises the provider.

The API accepts only loopback backend Host headers and frontend origins on localhost or this machine's interface IP addresses, requires JSON for chat/configuration bodies, and bounds request sizes. These safeguards reject unrelated browser origins and DNS rebinding; they do not authenticate LAN clients or other processes running as your OS user.

## Interface

- **Worlds** and **Personas** pages let you create, edit, browse, and select library entries. Campaigns capture the selected definitions as immutable snapshots at creation time, so later library edits never change an existing campaign's grounding.
- **New campaign** pairs a world and persona, shows the starting situation for review (seeded from the world's suggestion, editable, may be blank), and optionally takes a name. Creating it commits the campaign, its snapshots, and its opening session in one transaction; you land in the play screen and the narrator's opening streams in.
- **Play** shows the campaign breadcrumb, current session title, the streamed narration, and a composer labelled with your persona. Sending an action commits it server-side before the narrator replies; only one reply may be pending per session, so a second submission while one is streaming is rejected as busy without saving the extra input. **Stop** (from any browser tab) settles the reply as an interrupted draft and keeps the partial text; failures settle as failed drafts. Accepted actions are never lost and never resent automatically. The composer's model picker offers the Settings Default model; an explicit choice applies to that run, is kept in memory for the session, and never rewrites the saved Default.
- **Details** shows the captured campaign context (world and persona snapshots, starting situation) and the current session. The **sidebar** lists persisted campaigns; reopening one resumes its active session with the full transcript — the same from a reload, a server restart, or another browser. Non-complete narration renders as labelled drafts, with a retry for failed or interrupted openings.
- Open Settings from the User menu at the bottom of the sidebar or compact rail. General lives at `/settings/general`, with System / Light / Dark theme choices; Providers lives at `/settings/providers`. Back to app returns to your campaign without clearing its draft.
- Theme defaults to System and follows browser/OS light/dark changes live; explicitly picking Light or Dark overrides System until you switch back (saved in browser localStorage). The User avatar is a display-only placeholder, not an account.
- Collapse the sidebar on desktop to a narrow icon rail (preference saved); its logo toggles expansion, with the sidebar icon revealed on hover or keyboard focus. The route-agnostic rail always offers New campaign, Worlds, and Personas (the full layout also lists campaigns); on mobile it remains a slide-in drawer. Expanding lays the full sidebar out at its resting width inside the clipped shell and reveals it, so its labels never re-wrap mid-animation.
- Press Enter to send an action or Shift+Enter for a newline. The transcript keeps new messages in view while you are near the bottom and hands scrolling back to you the moment you scroll up to read.

Settings uses browser-history routes. Production hosting must serve `index.html` for application URLs such as `/settings/general` so direct links and refreshes work (Vite dev/preview already handle this).

## Worlds, campaigns, and server-owned play (M1)

Worlds, personas, campaigns, sessions, and messages persist in a local SQLite database (Bun's `bun:sqlite`, no ORM) at `<data dir>/storyfold.db`. The data dir defaults to the configuration directory (`~/.config/storyfold`); override it with `STORYFOLD_DATA_DIR` (a directory) and the credentials directory with `STORYFOLD_CONFIG_DIR`. The startup sweep settles any reply still `pending` from a previous process as `interrupted`; generation never auto-resumes.

Creating a campaign captures the selected world and persona into immutable snapshots, creates its opening session, and links it as the campaign's active session in one committed transaction — later library edits affect new campaigns only. Messages get server-assigned `position` order; `speaker_name` labels are captured at send time and never re-derived from the library.

The browser never owns play history. It sends a session id plus either new input (`POST /api/sessions/:id/messages`) or an explicit opening request (`POST /api/sessions/:id/opening`); both return a TanStack AI SSE stream and carry `x-storyfold-accepted` plus `x-storyfold-player-message-id` / `x-storyfold-pending-message-id` headers identifying the saved rows. The player's turn commits before the model is invoked; only one `pending` assistant reply may exist per session (concurrent submissions get `409 {code:"busy"}` with nothing saved). The server owns the reply lifecycle: completion requires normal-stop evidence from the provider, Stop (`POST /api/sessions/:id/stop`, works from any browser) or a disconnect settles the reply `interrupted` with its partial text preserved, and provider failures settle it `failed` — accepted player input always survives, and only completed narration plus accepted input feed later model calls, in position order, under fixed narrator instructions built from the campaign snapshots. Nothing is compacted or truncated; a context-limit failure surfaces as a `context_limit` error. Browse the domain via `GET/POST /api/worlds` and `GET/PATCH /api/worlds/:id`, `GET/POST /api/personas` and `GET/PATCH /api/personas/:id`, `GET/POST /api/campaigns` and `GET /api/campaigns/:id`, and `GET /api/sessions/:id` (+ `/messages`). A missing provider key answers `400 {code:"no_provider", accepted:true, ...ids}` with the input saved and the draft marked failed.

## UI components

The composer, transcript scroller, tooltips, and theme indicator are adapted from [beUI](https://beui.dev) registry sources (installed by copying and trimming the component code, not via the shadcn CLI):

- [Prompt Input](https://beui.dev/components/agents/prompt-input) — composer form, keyboard submission with IME safety, send-button motion, and a Stop control during generation. The model picker offers the provider Default with an optional per-message override; attachment UI is omitted. Auto-grow uses the repo's `field-sizing` CSS instead of the registry's measurement mirror, so browsers without `field-sizing` show a fixed-height scrolling composer. Focus uses the existing rounded composer border; forced-colors mode retains a visible textarea outline.
- [Message Scroller](https://beui.dev/components/agents/message-scroller) — reader-aware transcript viewport. Deviations: viewport resizes (composer growth, mobile drawer) re-align the live edge instantly while you are following, wheel, touch, and upward keyboard scrolling interrupt an in-flight follow, and the optional message navigation rail is omitted.
- [Tooltip](https://beui.dev/components/motion/tooltip) — hover/focus tooltips on the sidebar rail.
- [Tabs](https://beui.dev/components/motion/tabs) — shared-layout spring indicator adapted to the settings theme radios, without tab panels or overflow controls. The pill slides between choices; reduced-motion users get an instant selection change.

Dependencies added for these components: `motion` (reduced-motion-aware animation), `@floating-ui/dom` (tooltip positioning), `lucide-react` (send icon), and `clsx` + `tailwind-merge` (the `cn` class helper).

The User menu uses Radix Dropdown Menu; page navigation uses React Router. Settings theme choices use native radios for keyboard navigation and accessible selection.