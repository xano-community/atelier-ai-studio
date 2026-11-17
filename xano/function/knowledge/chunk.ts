// Splitting a document's text into passages. Paragraphs are kept whole and gathered until the next one wouldn't fit; a
// paragraph longer than a passage is split at its sentences, and a sentence longer than that at the passage length.
// Headings stay with the paragraph after them, because they're gathered the same way.
import { c, defineFunction, expect, expr, fl, inp, input, ref, resp, s, withFilters } from "@xano/sdk";

/** About 300 tokens: long enough to answer from, short enough that the 20 nearest still fit one prompt. */
export const PASSAGE_CHARS = 1200;
/** A passage this short says nothing on its own (a page number, a lone heading at the end). */
const SHORTEST = 3;

const len = (name: string) => withFilters(ref(name), fl.strlen());

export const chunkFn = defineFunction({
  name: "knowledge/chunk",
  description: "Split text into passages of up to max_chars, keeping paragraphs whole where they fit.",
  input: { text: input.text(), max_chars: input.int() },
  stack: [
    s.set_var("most", withFilters(inp("max_chars"), fl.first_notempty(c.int(PASSAGE_CHARS)), fl.to_int(), fl.clamp_min(100))),
    s.set_var("clean", withFilters(inp("text"), fl.first_notnull(c.text("")), fl.to_text())),
    s.update_var("clean", withFilters(c.regex(/\r\n?/), fl.regex_replace(c.text("\n"), ref("clean")))),
    s.update_var("clean", withFilters(c.regex(/\n[ \t]*(\n[ \t]*)+/), fl.regex_replace(c.text("\n\n"), ref("clean")))),
    s.set_var("paragraphs", withFilters(ref("clean"), fl.split("\n\n"))),
    // Pieces no longer than a passage: whole paragraphs, or a long one's sentences, or a long sentence's slices.
    s.set_var("pieces", c.array([])),
    s.foreach({ list: ref("paragraphs"), as: "para", body: [
      s.set_var("p", withFilters(ref("para"), fl.trim())),
      s.conditional({
        when: expr(len("p"), "<=", ref("most")),
        then: [s.conditional({ when: expr(ref("p"), "!=", c.text("")), then: [s.array.push({ name: "pieces", value: ref("p") })] })],
        else: [
          s.set_var("sentences", withFilters(c.regex(/([.!?])\s+/), fl.regex_replace(c.text("$1\u0001"), ref("p")), fl.split("\u0001"))),
          s.foreach({ list: ref("sentences"), as: "sentence", body: [
            s.set_var("said", withFilters(ref("sentence"), fl.trim())),
            s.conditional({
              when: expr(len("said"), "<=", ref("most")),
              then: [s.conditional({ when: expr(ref("said"), "!=", c.text("")), then: [s.array.push({ name: "pieces", value: ref("said") })] })],
              else: [
                s.set_var("at", c.int(0)),
                s.while({ when: expr(ref("at"), "<", len("said")), body: [
                  s.array.push({ name: "pieces", value: withFilters(ref("said"), fl.substr(ref("at"), ref("most")), fl.trim()) }),
                  s.update_var("at", withFilters(ref("at"), fl.add(ref("most")))),
                ] }),
              ],
            }),
          ] }),
        ],
      }),
    ] }),
    // Gather pieces into passages: a new passage starts when the next piece wouldn't fit.
    s.set_var("passages", c.array([])),
    s.set_var("current", c.text("")),
    s.foreach({ list: ref("pieces"), as: "piece", body: [
      s.set_var("joined", withFilters(len("current"), fl.add(2), fl.add(withFilters(ref("piece"), fl.strlen())))),
      s.conditional({
        when: expr(ref("current"), "=", c.text("")),
        then: [s.update_var("current", ref("piece"))],
        elif: [{ when: expr(ref("joined"), ">", ref("most")), then: [
          s.array.push({ name: "passages", value: ref("current") }),
          s.update_var("current", ref("piece")),
        ] }],
        else: [s.update_var("current", withFilters(ref("current"), fl.concat(c.text("\n\n")), fl.concat(ref("piece"))))],
      }),
    ] }),
    s.conditional({ when: expr(ref("current"), "!=", c.text("")), then: [s.array.push({ name: "passages", value: ref("current") })] }),
    s.array.filter({ expr: ref("passages"), if: expr(withFilters(ref("$this"), fl.strlen()), ">=", c.int(SHORTEST)), as: "kept" }),
  ],
  response: ref("kept"),
  responseShape: [] as string[],
  tests: [
    { name: "short paragraphs are gathered into one passage", input: { text: c.text("# Sizing\n\nMedium fits 170 to 178 cm.\r\n\r\n\r\nLarge fits 176 to 186 cm."), max_chars: c.int(200) }, expect: [
      expect.to_equal(withFilters(resp(), fl.count()), c.int(1)),
      expect.to_equal(withFilters(resp(), fl.first()), c.text("# Sizing\n\nMedium fits 170 to 178 cm.\n\nLarge fits 176 to 186 cm.")),
    ] },
    { name: "a paragraph that doesn't fit starts the next passage", input: { text: c.text(`${"a".repeat(80)}\n\n${"b".repeat(80)}\n\n${"c".repeat(30)}`), max_chars: c.int(120) }, expect: [
      expect.to_equal(withFilters(resp(), fl.count()), c.int(2)),
      expect.to_equal(withFilters(resp(), fl.first()), c.text("a".repeat(80))),
      expect.to_equal(withFilters(resp(), fl.last()), c.text(`${"b".repeat(80)}\n\n${"c".repeat(30)}`)),
    ] },
    { name: "a long paragraph is split at its sentences, and a long sentence at the limit", input: {
      text: c.text(`${"First sentence here. ".repeat(4).trim()} ${"x".repeat(250)}`), max_chars: c.int(100),
    }, expect: [
      // 4 sentences of 20 characters gather to 86, then the 250-character run is cut at 100, 100 and 50.
      expect.to_equal(withFilters(resp(), fl.count()), c.int(4)),
      expect.to_equal(withFilters(resp(), fl.first()), c.text("First sentence here.\n\nFirst sentence here.\n\nFirst sentence here.\n\nFirst sentence here.")),
      expect.to_equal(withFilters(resp(), fl.last()), c.text("x".repeat(50))),
    ] },
    { name: "empty text has no passages", input: { text: c.text("  \n\n  "), max_chars: c.int(100) }, expect: [
      expect.to_equal(withFilters(resp(), fl.count()), c.int(0)),
    ] },
  ],
});
