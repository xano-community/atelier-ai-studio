// How a run's steps hang together, for the rail beside them. Steps run one after another, in order; a step can also use
// what an earlier step made. A step that uses the one just before it joins it with a solid line on the rail; one that only
// runs after it, with a dotted line. A step that uses one further up gets its own branch, drawn in a lane to the left of
// the rail, so "the voiceover reads the copy from step 1" is visible at a glance. Branches that would cross get a lane each.

export type PipeStep = { seq: number; depends_on?: number[] };

/** A branch from step `from` down to step `to`, in lane `lane` (0 is the one next to the rail). */
export type Branch = { from: number; to: number; lane: number };

export type Pipeline = {
  /** For each step but the last, whether the next step uses it (solid) or only runs after it (dotted). */
  joins: Record<number, "uses" | "after">;
  branches: Branch[];
  lanes: number;
};

export function pipeline(steps: PipeStep[]): Pipeline {
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  const joins: Pipeline["joins"] = {};
  const spans: { from: number; to: number }[] = [];
  ordered.forEach((step, i) => {
    const next = ordered[i + 1];
    if (next) joins[step.seq] = (next.depends_on ?? []).includes(step.seq) ? "uses" : "after";
    for (const dep of step.depends_on ?? []) {
      const at = ordered.findIndex((s) => s.seq === dep);
      // The step just before is the rail itself; a step that isn't in the run (or comes later) draws nothing.
      if (at >= 0 && at < i - 1) spans.push({ from: dep, to: step.seq });
    }
  });
  // In order down the run, each branch takes the first lane whose last branch ended above where this one starts.
  spans.sort((a, b) => a.from - b.from || a.to - b.to);
  const laneEnds: number[] = [];
  const branches = spans.map((span) => {
    let lane = laneEnds.findIndex((end) => end < span.from);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(span.to); } else laneEnds[lane] = span.to;
    return { ...span, lane };
  });
  return { joins, branches, lanes: laneEnds.length };
}

/** The px the rail takes: the 24 px marks, plus 14 px for each lane of branches. */
export const LANE_PX = 14;
export const railWidth = (lanes: number) => 24 + LANE_PX * lanes;
/** A lane's line, in px from the rail's left edge: lane 0 sits next to the marks. */
export const laneX = (lane: number, lanes: number) => (lanes - 1 - lane) * LANE_PX + 5;

/** What a step makes, as the shape of its output: a picture's aspect, a clip's frame or a recording's strip. */
export type SlotShape = { kind: "image" | "video" | "audio"; width: number; height: number } | null;

const ratioOf = (value: unknown, fallback: number) => {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(value ?? ""));
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : fallback;
};

/** The output slot of a media step, at most `box` px wide and `height` tall; null for words and lookups. */
export function slotShape(kind: string, options: Record<string, unknown> | undefined, height = 32, box = 56): SlotShape {
  if (kind === "speech" || kind === "music") return { kind: "audio", width: box, height };
  if (kind !== "image" && kind !== "video") return null;
  const ratio = ratioOf(options?.aspect_ratio, kind === "video" ? 16 / 9 : 1);
  const width = Math.min(box, Math.round(height * ratio));
  return { kind, width, height: ratio * height > box ? Math.round(box / ratio) : height };
}
