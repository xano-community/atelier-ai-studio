import { f, table } from "@xano/sdk";
import { PRICE_KINDS, PRICE_UNITS, PRICES } from "../../prices.js";

/**
 * What a model costs, one row per unit (micro-dollars; tokens per 1M). Seeded from xano/prices.ts, and an admin can edit
 * it. A model with no row isn't run: the gateway never charges zero, so neither does an estimate.
 */
export const price = table({
  name: "price",
  description: "Each model's price per unit, in micro-dollars (tokens per 1M): what estimates multiply.",
  schema: {
    model: f.text({ required: true }),
    kind: f.enum(PRICE_KINDS, { required: true }),
    unit: f.enum(PRICE_UNITS, { required: true }),
    /** Which price of several: an image size ("1K"), a video resolution and sound ("1080p/audio"), an embedding's input ("image"). */
    variant: f.text(),
    amount: f.int({ required: true }),
    /** A price the catalog says takes over later, and from when (epoch ms). 0 when there's none. */
    later_amount: f.int(),
    later_from: f.int(),
    /** The catalog's own words for the price. */
    label: f.text(),
  },
  index: [{ type: "btree|unique", fields: [{ name: "model", op: "asc" }, { name: "unit", op: "asc" }, { name: "variant", op: "asc" }] }],
  seed: PRICES,
});
