import { TriangleAlert, UserPlus } from "lucide-react";
import type { CampaignCharacter } from "../../shared/domain";
import { narrationSegments } from "../lib/speakerTags";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";

/**
 * Narration with `[Name]`-tagged paragraphs attributed to their speaker.
 * Campaign characters open in the campaign panel; walk-ons (labels matching
 * no campaign character) can be added to the cast.
 */
export function Narration(props: {
  content: string;
  streaming?: boolean;
  characters: CampaignCharacter[];
  onAddToCast?: (name: string) => void;
  onShowCharacter?: (characterId: string) => void;
}) {
  const segments = narrationSegments(props.content, props.characters, props.streaming);
  return (
    <div className="grid gap-4">
      {segments.map((segment, index) => {
        const streaming = props.streaming && index === segments.length - 1;
        if (segment.kind === "narration") return <Markdown key={index} content={segment.text} streaming={streaming} />;
        const { character, label } = segment;
        const show = character && props.onShowCharacter ? () => props.onShowCharacter?.(character.id) : undefined;
        const portrait = (
          <Avatar
            name={label}
            imageId={character?.avatar_id}
            portrait
            className={`h-16 w-12 text-sm${character ? "" : " outline-1 outline-offset-2 outline-dashed outline-muted"}`}
          />
        );
        return (
          <div key={index} className="flex items-start gap-3">
            {show ? (
              <button type="button" tabIndex={-1} aria-hidden="true" className="pressable flex-none rounded-lg" onClick={show}>
                {portrait}
              </button>
            ) : portrait}
            <div className="min-w-0 flex-1">
              <p className="mbe-1 flex flex-wrap items-center gap-x-2 text-sm font-semibold">
                {show ? (
                  <button
                    type="button"
                    className="pressable rounded-sm underline-offset-2 [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                    onClick={show}
                    aria-label={`Show ${label}`}
                  >
                    {label}
                  </button>
                ) : <span>{label}</span>}
                {character?.role === "protagonist" && (
                  <span className="inline-flex items-center gap-1 text-xs font-normal text-muted">
                    <TriangleAlert className="size-3.5 flex-none" aria-hidden="true" />
                    Narrator wrote your character
                  </span>
                )}
                {!character && <span className="text-xs font-normal text-muted">Walk-on</span>}
                {!character && props.onAddToCast && (
                  <button
                    type="button"
                    className="pressable inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-normal text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
                    onClick={() => props.onAddToCast?.(label)}
                  >
                    <UserPlus className="size-3.5 flex-none" aria-hidden="true" />
                    Add to cast
                  </button>
                )}
              </p>
              <Markdown content={segment.text} streaming={streaming} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
