# Storyfold

Storyfold is a local, single-user interactive roleplay app built with React, TypeScript, Vite, Tailwind CSS, and Bun. A local Bun server persists worlds, characters, campaigns, and transcripts, and streams narrator replies from Z.AI using TanStack AI.

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

- **Worlds** and **Characters** pages let you create, edit, browse, and select library entries. Characters is the single global cast library (name, description, plus authored appearance, personality, background, baseline motivations, and speaking style). Worlds also provides a grouped local NPC, location, lore, and opening-scene compendium with create, edit, and delete, plus the world's cast: global characters associated with that world along with freeform world-specific context. The app keeps both libraries in shared in-memory state for Worlds, Characters, and **New campaign**; page visits and window focus revalidate in the background, and saves update the cache immediately. On **Worlds** and **Characters**, slow cold reads show card skeletons after about 200ms; cold failures offer retry, while failed refreshes preserve the last state (including an empty library) and show a retry notice.
- **New campaign** pairs a world with a protagonist — the character you play — and a narrator-controlled cast. The cast may include any global character, including ones outside the world's cast; the protagonist is part of the campaign once and is never grounded twice. Cast members contribute their captured definition plus the world-specific context of the world's cast (none outside it). No narrator-controlled characters, local NPCs, locations, or lore are selected by default (the protagonist picker defaults to the first character in the library), with **Select all** within each category plus a preview of included text. Opening scenes copy their description into the editable starting situation and confirm before replacing manual edits. A live combined grounding counter blocks creation above 32,000 characters. The starting situation is seeded from the world's suggestion and may be blank; a campaign name is optional. Creating a campaign commits its snapshots and opening session in one transaction.
- **Play** shows the campaign breadcrumb, current session title, the streamed narration, and a composer labelled with your character. Sending an action commits it server-side before the narrator replies; only one reply may be pending per session, so a second submission while one is streaming is rejected as busy without saving the extra input. **Stop** (from any browser tab) settles the reply as an interrupted draft and keeps the partial text; failures settle as failed drafts. Accepted actions are never lost and never resent automatically. The narrator voices every other cast member; your character's words and decisions are never narrated for you. The composer's model picker offers the Settings Default model; an explicit choice applies to that run, is kept in memory for the session, and never rewrites the saved Default.
- **Details** shows the captured world, protagonist, and cast snapshots, starting situation, selected compendium entry snapshots, and current session. The **sidebar** lists persisted campaigns; reopening one resumes its active session with the full transcript — the same from a reload, a server restart, or another browser. Non-complete narration renders as labelled drafts, with a retry for failed or interrupted openings.
- Open Settings from the User menu at the bottom of the sidebar or compact rail. General lives at `/settings/general`, with System / Light / Dark theme choices; Providers lives at `/settings/providers`. Back to app returns to your campaign without clearing its draft.
- Theme defaults to System and follows browser/OS light/dark changes live; explicitly picking Light or Dark overrides System until you switch back (saved in browser localStorage). The User avatar is a display-only placeholder, not an account.
- Collapse the sidebar on desktop to a narrow icon rail (preference saved); its logo toggles expansion, with the sidebar icon revealed on hover or keyboard focus. The route-agnostic rail always offers New campaign, Worlds, and Characters (the full layout also lists campaigns); on mobile it remains a slide-in drawer. Expanding lays the full sidebar out at its resting width inside the clipped shell and reveals it, so its labels never re-wrap mid-animation.
- Press Enter to send an action or Shift+Enter for a newline. The transcript keeps new messages in view while you are near the bottom and hands scrolling back to you the moment you scroll up to read.

Settings uses browser-history routes. Production hosting must serve `index.html` for application URLs such as `/settings/general` so direct links and refreshes work (Vite dev/preview already handle this).

## Worlds, campaigns, and server-owned play (M1)

Worlds, characters, campaigns, sessions, and messages persist in a local SQLite database (Bun's `bun:sqlite`, no ORM) at `<data dir>/storyfold.db`. The data dir defaults to the configuration directory (`~/.config/storyfold`); override it with `STORYFOLD_DATA_DIR` (a directory) and the credentials directory with `STORYFOLD_CONFIG_DIR`. The startup sweep settles any reply still `pending` from a previous process as `interrupted`; generation never auto-resumes.

Creating a campaign captures the world, the protagonist, and the narrator cast into immutable snapshots, creates its opening session, and links it as the campaign's active session in one committed transaction — later library edits affect new campaigns only. Messages get server-assigned `position` order; `speaker_name` labels are captured at send time and never re-derived from the library (a player's turn is always spoken as the captured protagonist name).

The browser never owns play history. It sends a session id plus either new input (`POST /api/sessions/:id/messages`) or an explicit opening request (`POST /api/sessions/:id/opening`); both return a TanStack AI SSE stream and carry `x-storyfold-accepted` plus `x-storyfold-player-message-id` / `x-storyfold-pending-message-id` headers identifying the saved rows. The player's turn commits before the model is invoked; only one `pending` assistant reply may exist per session (concurrent submissions get `409 {code:"busy"}` with nothing saved). The server owns the reply lifecycle: completion requires normal-stop evidence from the provider, Stop (`POST /api/sessions/:id/stop`, works from any browser) or a disconnect settles the reply `interrupted` with its partial text preserved, and provider failures settle it `failed` — accepted player input always survives, and only completed narration plus accepted input feed later model calls, in position order, under fixed narrator instructions built from the campaign snapshots. Nothing is compacted or truncated; a context-limit failure surfaces as a `context_limit` error. Browse the domain via `GET/POST /api/worlds` and `GET/PATCH /api/worlds/:id`, `GET/POST /api/characters` and `GET/PATCH /api/characters/:id`, `GET/POST /api/campaigns` and `GET /api/campaigns/:id`, and `GET /api/sessions/:id` (+ `/messages`). A missing provider key answers `400 {code:"no_provider", accepted:true, ...ids}` with the input saved and the draft marked failed.

## First-class characters and world casts (M2 revision)

Characters are a single global library (`characters` table, `GET/POST /api/characters`, `GET/PATCH /api/characters/:id`): a required name and description plus lean authored fields — appearance, personality, background, baseline motivations, speaking style — each optional and empty when unauthored. There is no attribute engine and no global delete; definitions are edited in place.

Worlds reference global characters through world-scoped cast associations (`world_characters`, managed under `GET/POST /api/worlds/:world_id/characters` and `PATCH/DELETE /api/worlds/:world_id/characters/:character_id`). An association carries only freeform world-specific context (occupation, affiliations, local background); the global definition is never copied into it, and an association id only resolves inside its own world's URL (otherwise `404`, like entries). Associating a character twice, or a malformed body, answers `400 {code:"invalid_input"}`.

Campaign creation takes `protagonist_id` (the character you play) and `cast_character_ids` (the narrator-controlled cast, which may include characters outside the world's cast). Duplicate entries in the `cast_character_ids` or `entry_ids` arrays, or the protagonist appearing in `cast_character_ids`, are rejected with `400`; unknown ids answer `404`. At creation — in the same transaction — every selected character is captured by value into `protagonist_snapshot` and `cast` (`[{id, name, description, appearance, personality, background, baseline_motivations, speaking_style, world_context}]`): the global definition as written plus the world cast's context (`""` outside any world cast). The protagonist grounds exactly once and is never also a cast member; the narrator is instructed to voice every cast member and never the protagonist. Later edits to characters, world casts, or the world never rewrite a captured campaign, and narration never re-resolves captured ids against the live library.

## World compendium (M2)

World entries — local NPCs, locations, lore, and opening-scene templates — persist in a `world_entries` table and are managed world-scoped under `GET/POST /api/worlds/:world_id/entries` and `PATCH/DELETE /api/worlds/:world_id/entries/:entry_id` (`200 {ok:true}` on delete). A local NPC is a simple name+description entry. An entry id only ever resolves inside its own world's URL, so another world's entry is indistinguishable from a missing one (`404`).

Campaign creation accepts `entry_ids`. Malformed arrays, duplicates, and `scene` entries are rejected with `400 {code:"invalid_input"}` — scenes are opening templates only: selecting one copies its description into the editable starting situation in the UI and is never captured as grounding. Unknown or other-world ids answer `404 {code:"not_found"}`. Selected entries are captured by value into `world_snapshot.entries` (`[{id, kind, name, description}]`, in selection order) inside the same creation transaction, so later library edits and deletes never rewrite an existing campaign, and narration is grounded only on that captured list — the live library is never re-resolved.

Entry mutations, including deletion, require a trusted `Origin` header. If a selected entry disappears from the shared browser cache, campaign submission omits it while preserving the remaining selection order; the server still rejects unknown IDs from stale clients.

Combined authored grounding — world name/brief, the starting situation, every authored field of the protagonist and of each cast member (each character exactly once, including its world context), and the selected entry names/descriptions — is capped at 32,000 characters. The same count is enforced server-side and shown live in the UI via the shared `groundingCharacterCount` helper in `shared/grounding.ts`; unauthored fields contribute nothing, over-limit selections are rejected with `400 {code:"invalid_input"}`, and nothing is ever truncated. This bounds authored input size; it is not a token-window guarantee, and the M1 context-limit error handling still applies.

## Campaign state, sequential sessions, and forks (M3)

**Manual campaign state** is campaign-owned text the player curates: categories `relationship`, `goal`, `knowledge`, `internal`, `attribute`, and `journal`, each item a required `subject` and `content`, with server timestamps. A subject is either a free-text campaign-local label (`subject_kind` and `subject_id` both `null`, the default) or a reference to a captured snapshot: `subject_kind: "character"` with a `subject_id` from the campaign's captured protagonist/cast, or `subject_kind: "entry"` with a captured compendium entry id. The pair must be set together and is validated at write time against the campaign's captured snapshots only — never the live library — so the reference survives library edits and deletes, while the `subject` text stays the stable display name used in prompts. Items live under `GET/POST /api/campaigns/:id/state` (list in creation order; create returns the bare item) and `PATCH/DELETE /api/campaigns/:id/state/:item_id` (delete answers `200 {ok:true}`; a PATCH may set or clear the reference pair, but never half of it). An item id resolves only inside its own campaign's URL, like entries and world casts. Journal chronology is the immutable `created_at` order — edits never reorder a journal. Mutations are refused with `409 {code:"busy"}` while a narration run is pending in the campaign's active session; nothing is saved by a refused request.

**Sessions are sequential and explicitly reviewed.** `POST /api/campaigns/:id/sessions {title, handoff}` closes the campaign's one open session (recording its `closed_at` and the reviewed `handoff`), checkpoints the campaign's current state — including subject references — at that boundary, opens the next session, and moves `active_session_id` — all in one committed transaction; the response is `{session}`. `GET /api/campaigns/:id/sessions` lists them in story order as `{sessions: [...]}`. Closed sessions are read-only: play and opening requests answer `409 {code:"session_closed"}` — a guard enforced again inside the write transaction, so a close that races an in-flight play request can never write into the closed session. Every open session accepts exactly one opening narration (retryable while only failed/interrupted drafts exist, `409 {code:"already_opened"}` once completed): the campaign's first opens from the starting situation, later sessions and forks continue from their leading handoff.

Narration is grounded per session on the captured world/protagonist/cast snapshots, the **current** campaign state, the **handoff leading into this session**, and **this session's history only** — a later session never sees the original starting situation or any earlier session's turns, and nothing is dropped silently: closed transcripts stay readable via `GET /api/sessions/:id/messages`.

**Context boundary.** A session's completed history (player inputs plus completed narration) is capped at 100,000 characters (`HISTORY_CHARACTER_LIMIT` in `server/play.ts`, counted as summed content length). An input that would pass the cap is refused with `413 {code:"context_limit", accepted:false}` and an actionable message; no message is saved and nothing is ever truncated. The cure is beginning the next session with a handoff.

**Forks.** `POST /api/sessions/:id/fork {name}` (201 `{campaign, session}`) forks a **completed** session (`409 {code:"session_not_closed"}` otherwise) into a new independent campaign: the captured world/protagonist/cast snapshots and starting situation are copied by value, the closed session's state checkpoint becomes the new campaign's state, its handoff grounds the new campaign's opening session, and the origin is recorded on the campaign as `forked_from_campaign_id` / `forked_from_session_id`. The origin is never re-resolved afterwards: later edits to the origin campaign's state or library never leak into the fork, and the origin keeps playing on unaffected. Ancestor transcripts stay reachable through the recorded origin session id.

## Development workspace

The M2/M3 schema cutovers changed tables and columns in place: there are no migrations and no compatibility layer. A database created before a cutover is left untouched on disk but cannot serve the new schema — the server never deletes or resets data. For development, point `STORYFOLD_DATA_DIR` at a fresh directory to get a clean database alongside any existing one; the workspace persists there across restarts:

```sh
STORYFOLD_DATA_DIR=$HOME/.local/share/storyfold-characters bun run dev --host
```

`bun run dev` starts the full stack (API and Vite) against that data directory. Backend tests always run against isolated temporary databases.

## UI components

The composer, transcript scroller, tooltips, and theme indicator are adapted from [beUI](https://beui.dev) registry sources (installed by copying and trimming the component code, not via the shadcn CLI):

- [Prompt Input](https://beui.dev/components/agents/prompt-input) — composer form, keyboard submission with IME safety, send-button motion, and a Stop control during generation. The model picker offers the provider Default with an optional per-message override; attachment UI is omitted. Auto-grow uses the repo's `field-sizing` CSS instead of the registry's measurement mirror, so browsers without `field-sizing` show a fixed-height scrolling composer. Focus uses the existing rounded composer border; forced-colors mode retains a visible textarea outline.
- [Message Scroller](https://beui.dev/components/agents/message-scroller) — reader-aware transcript viewport. Deviations: viewport resizes (composer growth, mobile drawer) re-align the live edge instantly while you are following, wheel, touch, and upward keyboard scrolling interrupt an in-flight follow, and the optional message navigation rail is omitted.
- [Tooltip](https://beui.dev/components/motion/tooltip) — hover/focus tooltips on the sidebar rail.
- [Tabs](https://beui.dev/components/motion/tabs) — shared-layout spring indicator adapted to the settings theme radios, without tab panels or overflow controls. The pill slides between choices; reduced-motion users get an instant selection change.

Dependencies added for these components: `motion` (reduced-motion-aware animation), `@floating-ui/dom` (tooltip positioning), `lucide-react` (send icon), and `clsx` + `tailwind-merge` (the `cn` class helper).

The User menu uses Radix Dropdown Menu; page navigation uses React Router. Settings theme choices use native radios for keyboard navigation and accessible selection.