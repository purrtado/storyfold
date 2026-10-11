import type { Conversation } from "./types";

export const uid = () => crypto.randomUUID();

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
