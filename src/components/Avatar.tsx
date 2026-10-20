function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (first + last).toUpperCase();
}

function hue(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return Math.abs(hash) % 360;
}

export function imageUrl(imageId: string) {
  return `/api/images/${encodeURIComponent(imageId)}`;
}

/** Character portrait: the captured image when present, else a name-derived monogram. */
export function Avatar(props: { name: string; imageId?: string | null; className?: string }) {
  const size = props.className ?? "size-10 text-sm";
  if (props.imageId) {
    return <img src={imageUrl(props.imageId)} alt="" className={`${size} flex-none rounded-full bg-raised object-cover`} />;
  }
  const h = hue(props.name);
  return (
    <span
      aria-hidden="true"
      className={`${size} inline-grid flex-none place-items-center rounded-full font-semibold select-none`}
      style={{
        background: `light-dark(oklch(90% 0.06 ${h}), oklch(34% 0.07 ${h}))`,
        color: `light-dark(oklch(35% 0.09 ${h}), oklch(90% 0.05 ${h}))`,
      }}
    >
      {initials(props.name)}
    </span>
  );
}
