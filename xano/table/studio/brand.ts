import { f, table } from "@xano/sdk";
import { user } from "../user.js";

/**
 * The team's brand kit: one row, added to prompts when a run asks for it. Words for voice and visuals go to text, image
 * and video prompts; the default voice and its style to speech; the music style to music. Empty until someone fills it.
 */
export const brand = table({
  name: "brand",
  description: "The brand kit: voice rules, words to avoid, visual rules, default voice and music style, and colours.",
  schema: {
    /** How the brand writes: tone, person, sentence length. */
    voice: f.text(),
    /** Words and phrases the brand never uses. A list of text. */
    avoid_words: f.json(),
    /** How the brand looks: light, framing, materials, what never appears. */
    visual_rules: f.text(),
    /** The speech voice runs use when they don't pick one. */
    default_voice: f.text(),
    /** How that voice speaks: pace, warmth, energy. */
    voice_style: f.text(),
    /** The music style runs add to their prompt. */
    music_style: f.text(),
    /** The palette: [{ name, hex }], six at most. */
    colours: f.json(),
    /** Who saved it last, and when. */
    updated_by: f.tableRef(user),
    updated_at: f.timestamp({ nullable: true }),
  },
  seed: [],
});

/**
 * The brand kit's reference images. A stored file can't be read back as something a model takes, so the image's own
 * bytes are kept here (base64) and turned into a file again for each image run that uses the kit. Three at most.
 */
export const brand_image = table({
  name: "brand_image",
  description: "A brand kit reference image: its name, type and size, and its bytes, sent with image runs that use the kit.",
  schema: {
    name: f.text({ required: true }),
    mime: f.text({ required: true }),
    size: f.int({ required: true }),
    /** The image's bytes, base64. Read only when an image run sends it, or when the page shows it. */
    data: f.text({ required: true, access: "private" }),
    added_by: f.tableRef(user, { required: true }),
  },
  seed: [],
});
