import type { Conversation } from "./types";

// crypto.randomUUID only exists in secure contexts (localhost/HTTPS); LAN HTTP
// origins need a fallback for dev access. RFC 9562 UUID v4.
export function uid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Clearly-marked sample content so the UI demonstrates markdown before any
// real conversation exists. These are never sent anywhere.
export const sampleConversations = (): Conversation[] => [
  {
    id: uid(),
    title: "Sample: formatting tour",
    createdAt: Date.now() - 1000 * 60 * 60 * 26,
    messages: [
      {
        id: uid(),
        role: "user",
        content: "What kinds of formatting can you show me?",
      },
      {
        id: uid(),
        role: "assistant",
        content: `This conversation is **sample content** so you can see how replies will render. No AI is connected yet.

## Lists and emphasis

Storyfold will support *italics*, **bold**, \`inline code\`, and [links](https://example.com), plus ordered lists:

1. Write a prompt
2. Fold the reply into your story
3. Keep going

> Blockquotes will render like this, set off from the flow of the story.

## Code blocks

\`\`\`ts
// Code blocks get syntax-friendly styling.
function fold(pages: string[]): string {
  return pages.join("\\n\\f");
}
\`\`\`

Tables work too:

| Feature | Status |
| --- | --- |
| Markdown replies | Sampled |
| AI replies | Not connected |`,
      },
    ],
  },
  {
    id: uid(),
    title: "Sample: plotting with the hero's journey",
    createdAt: Date.now() - 1000 * 60 * 60 * 3,
    messages: [
      {
        id: uid(),
        role: "user",
        content:
          "Can you outline a lighthouse keeper's story using the hero's journey?",
      },
      {
        id: uid(),
        role: "assistant",
        content: `> **Sample content** — a demo of what a brainstorming reply will look like.

**Ordinary world.** Maren keeps the last manned lighthouse on the Sound.

**Call to adventure.** The light fails during the equinox storm, and a ship that shouldn't exist asks for harbor.

**Refusal.** She logs the night as fog. Some stones are better left unturned.`,
      },
    ],
  },
];
