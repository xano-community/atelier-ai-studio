// What Marlow's Knowledge holds on a fresh deploy: the documents and call recordings the team added, as the passages reading
// them would have made. The words live here, apart from the rest of the world, because scripts/seed-vectors.mjs embeds these
// same passages once and commits their vectors as xano/seed-vectors.json, so a deploy shows working Knowledge with no AI.
import { readFileSync } from "node:fs";
import { KB_WORDS } from "./function/knowledge/absorb.js";

export type SeedPassage = { text: string; page: number; start_s: number; speaker: string };
export type SeedSource = {
  title: string; kind: "document" | "recording"; format: "pdf" | "text" | "markdown" | "audio";
  /** The file it came from, in xano/seed-files/, or "" for words typed in. */
  file: string; file_name: string; mime: string; pages: number; duration_s: number;
  /** A DEMO_PEOPLE position. */
  by: number;
  status: "ready" | "failed"; detail: string;
  passages: SeedPassage[];
};

const JORDAN = 1, SAM = 2, PRIYA = 3;
const seedFile = (name: string) => readFileSync(new URL(`./seed-files/${name}`, import.meta.url), "utf8");

/** A Markdown document's passages: one per section, its heading kept with its words. */
const sections = (markdown: string, page = 0): SeedPassage[] => markdown.trim().split(/\n(?=## )/)
  .map((part) => part.trim()).filter((part) => part.length > 2).map((text) => ({ text, page, start_s: -1, speaker: "" }));

type Line = { start: number; speaker: string; text: string };
/** A recording's passages: its lines gathered while they fit, each passage starting at its first line's time and speaker. */
const RECORDING_PASSAGE_CHARS = 420;
const gathered = (lines: Line[]): SeedPassage[] => {
  const out: SeedPassage[] = [];
  for (const line of lines) {
    const piece = `${line.speaker}: ${line.text}`;
    const last = out.at(-1);
    if (last && last.text.length + 1 + piece.length <= RECORDING_PASSAGE_CHARS) last.text += `\n${piece}`;
    else out.push({ text: piece, page: 0, start_s: Math.floor(line.start), speaker: line.speaker });
  }
  return out;
};

/** The Halden Cycles call (Priya and Riley, Halden's buyer), as the transcription step wrote its lines. */
const HALDEN_LINES: Line[] = [
  { start: 0, speaker: "Speaker 1", text: "Thanks for making time, Riley. I wanted to talk through how the Trail 2 is landing with your customers." },
  { start: 5, speaker: "Speaker 2", text: "Sure. Overall it's selling well. The sage green is the most popular color by a long way." },
  { start: 11, speaker: "Speaker 1", text: "Good to hear. What about sizing? We've heard mixed things." },
  { start: 15, speaker: "Speaker 2", text: "That's the main one. People between a medium and a large keep asking us. We tell them to take the medium, because it rides long." },
  { start: 23, speaker: "Speaker 1", text: "Is that the reach, mostly?" },
  { start: 25, speaker: "Speaker 2", text: "Yes, the reach on the large surprised a few of our test riders. Two of the three people who tried both picked the smaller frame." },
  { start: 33, speaker: "Speaker 1", text: "That matches our size guide, which says to size down for a more upright position." },
  { start: 39, speaker: "Speaker 2", text: "Right, but nobody reads the guide in the shop. A short video showing the fit would help a lot." },
  { start: 44, speaker: "Speaker 1", text: "We're planning a launch kit with a short clip. Would a voiceover about sizing be useful?" },
  { start: 50, speaker: "Speaker 2", text: "Very, and mention the new tire clearance. Customers love that it takes 2.4 inch tires now." },
  { start: 57, speaker: "Speaker 1", text: "Noted. Anything on the warranty?" },
  { start: 59, speaker: "Speaker 2", text: "The lifetime frame warranty closes a lot of sales. Put it front and center." },
  { start: 66, speaker: "Speaker 1", text: "Great. I'll send over the draft copy by Thursday." },
  { start: 69, speaker: "Speaker 2", text: "Perfect. Thanks. Talk soon." },
];

/** The Oak & Spoke call (Priya and Tom, the Bristol dealer), as the transcription step wrote its lines. */
const OAK_AND_SPOKE_LINES: Line[] = [
  { start: 0, speaker: "Speaker 1", text: "Hi Tom, it's Priya from Marlow. Thanks for making time. I wanted to hear how the City 3 is doing at Oak and Spoke." },
  { start: 9.1, speaker: "Speaker 2", text: "Happy to. It's our best seller for commuters this autumn. People love how upright it is." },
  { start: 15.2, speaker: "Speaker 1", text: "That's good to hear. Is it the riding position that sells it?" },
  { start: 19.9, speaker: "Speaker 2", text: "That, and the hub gears. Nobody wants to clean a chain in the rain. The eight speed hub is a big part of the pitch." },
  { start: 27.2, speaker: "Speaker 1", text: "What do people struggle with?" },
  { start: 29.7, speaker: "Speaker 2", text: "The rack mounts. Customers can't tell which bolts are for the rack and which are for the mudguards. We explain it every time." },
  { start: 37.6, speaker: "Speaker 1", text: "Would a short video help?" },
  { start: 40.1, speaker: "Speaker 2", text: "Yes. A thirty second voiceover showing where the rack goes would save us a lot of time." },
  { start: 45.9, speaker: "Speaker 1", text: "Noted. What gets asked about most?" },
  { start: 49.6, speaker: "Speaker 2", text: "The dynamo lights, by far. People ask about them before they ask about the price." },
  { start: 55.5, speaker: "Speaker 1", text: "Anything on sizing?" },
  { start: 57.7, speaker: "Speaker 2", text: "A few riders over a hundred and ninety centimetres want an extra large. The large is a bit short for them." },
  { start: 64.2, speaker: "Speaker 1", text: "Thanks, Tom. I'll take the XL request back to the team." },
];

/** The size guide PDF, as reading it to Markdown gave it back. */
const SIZE_GUIDE = `# Marlow size guide

Draft for sales review. Measure inside leg in bare feet, then read across. Between two sizes, take the smaller for a road frame and the larger for touring.

## Frames by rider height

| Frame | Rider height | Inside leg | Models |
|---|---|---|---|
| XS (48 cm) | 152 to 162 cm | 68 to 74 cm | Ridgeway, Fen |
| S (51 cm) | 160 to 170 cm | 72 to 78 cm | Ridgeway, Fen, Dale |
| M (54 cm) | 168 to 178 cm | 76 to 82 cm | All models |
| L (57 cm) | 176 to 186 cm | 80 to 86 cm | All models |
| XL (60 cm) | 184 to 196 cm | 84 to 92 cm | Ridgeway, Dale |

Questions go to the Marlow client room. This page moves above the fold on every product page at launch.`;

/** Typed in by Sam: what the team knows about the City 3, for copy and captions. */
const CITY_3_NOTES = `## City 3 in one line
An upright commuter with an 8-speed hub, a belt-ready frame and dynamo lights, for riders who want to arrive dry and in a good mood. £1,290, in slate and oat.

## What riders like
The upright position and the hub gears come up in every dealer call. Nobody wants to clean a chain in the rain. The dynamo lights are the most-asked feature, often before the price.

## What confuses people
The rack and mudguard mounts sit close together on the rear dropout. Dealers explain which bolt is which every time. A short voiceover video showing where the rack goes is on the autumn list.

## Sizing
S, M and L today. Riders over 190 cm ask for an XL; the L is a little short for them. Product is looking at an XL for spring.`;

/** Typed in by Jordan: the autumn plan the launch kit runs against. */
const AUTUMN_PLAN = `## Autumn launch plan
Trail 2 in sage green leads the autumn push, with City 3 as the commuting story. Each product gets a launch kit: copy, a hero image, an 8 second clip, a voiceover and a music bed.

## Channels
Product pages first, then social. Dealers get the hero image and the voiceover a week before the public launch, so the shop floor says the same thing as the site.

## Budget
Video is the expensive part. Members ask before running a video; the team budget is $100 a month, $25 each. Draft everything in the Playground first, then run the recipe once the prompt is right.

## Messages that matter
Sizing (the Trail 2 rides long: between M and L, take the M), the 2.4 in tyre clearance, and the lifetime frame warranty.`;

export const SEED_SOURCES: SeedSource[] = [
  { title: "Marlow brand voice guide", kind: "document", format: "markdown", file: "marlow-brand-voice.md", file_name: "marlow-brand-voice.md", mime: "text/markdown",
    pages: 0, duration_s: 0, by: JORDAN, status: "ready", detail: "", passages: sections(seedFile("marlow-brand-voice.md")) },
  { title: "Trail 2 spec sheet", kind: "document", format: "markdown", file: "trail-2-spec-sheet.md", file_name: "trail-2-spec-sheet.md", mime: "text/markdown",
    pages: 0, duration_s: 0, by: SAM, status: "ready", detail: "", passages: sections(seedFile("trail-2-spec-sheet.md")) },
  { title: "Marlow size guide", kind: "document", format: "pdf", file: "marlow-size-guide.pdf", file_name: "marlow-size-guide.pdf", mime: "application/pdf",
    pages: 1, duration_s: 0, by: SAM, status: "ready", detail: "", passages: sections(SIZE_GUIDE, 1) },
  { title: "Customer call: Halden Cycles", kind: "recording", format: "audio", file: "call-halden-trail-2.mp3", file_name: "halden-cycles-call.mp3", mime: "audio/mpeg",
    pages: 0, duration_s: 72, by: PRIYA, status: "ready", detail: "", passages: gathered(HALDEN_LINES) },
  { title: "Dealer call: Oak & Spoke on the City 3", kind: "recording", format: "audio", file: "call-city-3-dealer.mp3", file_name: "oak-and-spoke-call.mp3", mime: "audio/mpeg",
    pages: 0, duration_s: 70, by: PRIYA, status: "ready", detail: "", passages: gathered(OAK_AND_SPOKE_LINES) },
  { title: "City 3 product notes", kind: "document", format: "text", file: "", file_name: "city-3-notes.txt", mime: "text/plain",
    pages: 0, duration_s: 0, by: SAM, status: "ready", detail: "", passages: sections(CITY_3_NOTES) },
  { title: "Autumn launch plan", kind: "document", format: "markdown", file: "", file_name: "autumn-launch-plan.md", mime: "text/markdown",
    pages: 0, duration_s: 0, by: JORDAN, status: "ready", detail: "", passages: sections(AUTUMN_PLAN) },
  { title: "Warranty terms 2027", kind: "document", format: "pdf", file: "warranty-terms-2027.pdf", file_name: "warranty-terms-2027.pdf", mime: "application/pdf",
    pages: 1, duration_s: 0, by: PRIYA, status: "failed", detail: KB_WORDS.scan, passages: [] },
];

/** Every passage's words, in seed order: what scripts/seed-vectors.mjs embeds. */
export const SEED_PASSAGE_TEXTS = SEED_SOURCES.flatMap((source) => source.passages.map((p) => p.text));
