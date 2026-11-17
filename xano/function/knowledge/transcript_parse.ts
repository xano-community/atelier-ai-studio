// A recording's transcript as timed passages. The transcript comes either as lines the model returned against a schema
// ({ start, speaker, text }, start in seconds or "mm:ss") or as text with lines like "[04:12] Speaker 2: …". Lines with
// no time at all are timed by their position, at about 150 words a minute, so a citation still lands near the moment.
// Lines are gathered into passages until the next wouldn't fit; each passage starts where its first line does and is
// labelled with that line's speaker.
import { c, defineFunction, expect, expr, fl, inp, input, obj, ref, resp, s, withFilters, type Value } from "@xano/sdk";

/** About 25 seconds of conversation: short enough that a citation plays close to what it quotes. */
export const TRANSCRIPT_PASSAGE_CHARS = 450;
/** Words a second when a line has no time of its own. */
const WORDS_PER_SECOND = 2.5;

const STAMP = /^\s*\[?(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?\]?\s*$/;
const STAMPED_LINE = /^\s*\[((?:\d+:)?\d{1,2}:\d{2})(?:\.\d+)?\]\s*(.*)$/;
const SPEAKER = /^((?:[Ss]peaker|SPEAKER)\s*\d+|[A-Z][a-z]+(?: [A-Z][a-z]+)?):\s+(.*)$/;

/** Binds `secs` from the text `stamp` ("04:12", "1:02:03"), or -1 when it isn't one. */
const toSeconds = (stamp: Value) => [
  s.set_var("parts", withFilters(c.regex(STAMP), fl.regex_match(withFilters(stamp, fl.first_notnull(c.text("")), fl.to_text())))),
  s.set_var("secs", c.int(-1)),
  s.conditional({ when: expr(withFilters(ref("parts"), fl.count()), ">=", c.int(4)), then: [
    s.update_var("secs", withFilters(ref("parts"), fl.get("1", 0), fl.to_int(), fl.mul(3600),
      fl.add(withFilters(ref("parts"), fl.get("2", 0), fl.to_int(), fl.mul(60))), fl.add(withFilters(ref("parts"), fl.get("3", 0), fl.to_int())))),
  ] }),
];

/** A field of the nth passage in the response under test. */
const passage = (i: number, field: string) => withFilters(resp("passages"), fl.get(String(i)), fl.get(field));

const words = (name: string) => withFilters(ref(name), fl.trim(), fl.split(" "), fl.filter_empty_text(), fl.count());

export const transcriptParseFn = defineFunction({
  name: "knowledge/transcript_parse",
  description: "Turn a transcript (schema lines, or text lines like \"[04:12] Speaker 2: …\") into timed passages with speakers.",
  input: { lines: input.json(), text: input.text(), max_chars: input.int() },
  stack: [
    s.set_var("most", withFilters(inp("max_chars"), fl.first_notempty(c.int(TRANSCRIPT_PASSAGE_CHARS)), fl.to_int(), fl.clamp_min(20))),
    s.set_var("norm", c.array([])),
    // A missing list arrives as an empty value, not an empty list: keep only real lines.
    s.set_var("given", withFilters(inp("lines"), fl.safe_array(), fl.filter_empty())),
    s.conditional({
      when: expr(withFilters(ref("given"), fl.count()), ">", c.int(0)),
      then: [s.foreach({ list: ref("given"), as: "line", body: [
        s.set_var("said", withFilters(ref("line"), fl.get("text", ""), fl.first_notnull(c.text("")), fl.to_text(), fl.trim())),
        s.set_var("raw_start", withFilters(ref("line"), fl.get("start", c.null()))),
        s.set_var("start", c.int(-1)),
        s.conditional({
          when: expr(withFilters(ref("raw_start"), fl.is_text()), "=", c.bool(true)),
          then: [
            ...toSeconds(ref("raw_start")),
            s.update_var("start", ref("secs")),
            // "252" or "252.4" as text: seconds.
            s.conditional({ when: [expr(ref("secs"), "<", c.int(0)), expr(withFilters(c.regex(/^\s*\d+(\.\d+)?\s*$/), fl.regex_test(ref("raw_start"))), "=", c.bool(true))], then: [
              s.update_var("start", withFilters(ref("raw_start"), fl.to_decimal(), fl.floor(), fl.to_int())),
            ] }),
          ],
          elif: [{ when: expr(ref("raw_start"), "!=", c.null()), then: [s.update_var("start", withFilters(ref("raw_start"), fl.to_decimal(), fl.floor(), fl.to_int(), fl.clamp_min(0)))] }],
        }),
        s.conditional({ when: expr(ref("said"), "!=", c.text("")), then: [s.array.push({ name: "norm", value: obj({
          start: ref("start"), speaker: withFilters(ref("line"), fl.get("speaker", ""), fl.first_notnull(c.text("")), fl.to_text(), fl.trim()), text: ref("said"),
        }) })] }),
      ] })],
      else: [
        s.set_var("text_lines", withFilters(c.regex(/\r\n?/), fl.regex_replace(c.text("\n"), withFilters(inp("text"), fl.first_notnull(c.text("")), fl.to_text())), fl.split("\n"))),
        s.foreach({ list: ref("text_lines"), as: "raw_line", body: [
          s.set_var("rest", withFilters(ref("raw_line"), fl.trim())),
          s.set_var("start", c.int(-1)),
          s.set_var("speaker", c.text("")),
          s.set_var("stamped", withFilters(c.regex(STAMPED_LINE), fl.regex_match(ref("rest")))),
          s.conditional({ when: expr(withFilters(ref("stamped"), fl.count()), ">=", c.int(3)), then: [
            ...toSeconds(withFilters(ref("stamped"), fl.get("1", ""))),
            s.update_var("start", ref("secs")),
            s.update_var("rest", withFilters(ref("stamped"), fl.get("2", ""), fl.to_text(), fl.trim())),
          ] }),
          s.set_var("named", withFilters(c.regex(SPEAKER), fl.regex_match(ref("rest")))),
          s.conditional({ when: expr(withFilters(ref("named"), fl.count()), ">=", c.int(3)), then: [
            s.update_var("speaker", withFilters(ref("named"), fl.get("1", ""), fl.to_text(), fl.trim())),
            s.update_var("rest", withFilters(ref("named"), fl.get("2", ""), fl.to_text(), fl.trim())),
          ] }),
          s.conditional({ when: expr(ref("rest"), "!=", c.text("")), then: [s.array.push({ name: "norm", value: obj({ start: ref("start"), speaker: ref("speaker"), text: ref("rest") }) })] }),
        ] }),
      ],
    }),
    // Lines with no time: by position when nothing has one, otherwise from the line before.
    s.array.filter_count({ expr: ref("norm"), if: expr(ref("$this.start"), ">=", c.int(0)), as: "timed" }),
    s.set_var("words_before", c.int(0)),
    s.set_var("last_start", c.int(0)),
    s.set_var("last_words", c.int(0)),
    s.set_var("timed_lines", c.array([])),
    s.foreach({ list: ref("norm"), as: "one", body: [
      s.set_var("one_text", ref("one.text")),
      s.set_var("at", ref("one.start")),
      s.conditional({
        when: expr(ref("timed"), "=", c.int(0)),
        then: [s.update_var("at", withFilters(ref("words_before"), fl.div(WORDS_PER_SECOND), fl.floor(), fl.to_int()))],
        elif: [{ when: expr(ref("at"), "<", c.int(0)), then: [s.update_var("at", ref("last_start"))] }],
      }),
      s.update_var("last_words", words("one_text")),
      s.update_var("words_before", withFilters(ref("words_before"), fl.add(ref("last_words")))),
      s.update_var("last_start", ref("at")),
      s.array.push({ name: "timed_lines", value: withFilters(ref("one"), fl.set("start", ref("at"))) }),
    ] }),
    // Gather lines into passages.
    s.set_var("passages", c.array([])),
    s.set_var("current", c.null()),
    s.foreach({ list: ref("timed_lines"), as: "one", body: [
      s.set_var("piece", ref("one.text")),
      s.conditional({ when: expr(ref("one.speaker"), "!=", c.text("")), then: [
        s.update_var("piece", withFilters(ref("one.speaker"), fl.concat(c.text(": ")), fl.concat(ref("one.text")))),
      ] }),
      s.conditional({
        when: expr(ref("current"), "=", c.null()),
        then: [s.update_var("current", obj({ text: ref("piece"), start_s: ref("one.start"), speaker: ref("one.speaker") }))],
        elif: [{
          when: expr(withFilters(ref("current.text"), fl.strlen(), fl.add(1), fl.add(withFilters(ref("piece"), fl.strlen()))), ">", ref("most")),
          then: [
            s.array.push({ name: "passages", value: ref("current") }),
            s.update_var("current", obj({ text: ref("piece"), start_s: ref("one.start"), speaker: ref("one.speaker") })),
          ],
        }],
        else: [s.update_var("current", withFilters(ref("current"), fl.set("text", withFilters(ref("current.text"), fl.concat(c.text("\n")), fl.concat(ref("piece"))))))],
      }),
    ] }),
    s.conditional({ when: expr(ref("current"), "!=", c.null()), then: [s.array.push({ name: "passages", value: ref("current") })] }),
    s.set_var("duration", c.int(0)),
    s.conditional({ when: expr(withFilters(ref("timed_lines"), fl.count()), ">", c.int(0)), then: [
      s.update_var("duration", withFilters(ref("last_words"), fl.div(WORDS_PER_SECOND), fl.ceil(), fl.to_int(), fl.add(ref("last_start")))),
    ] }),
  ],
  response: { passages: ref("passages"), duration_s: ref("duration") },
  responseShape: {} as { passages: { text: string; start_s: number; speaker: string }[]; duration_s: number },
  tests: [
    { name: "stamped lines keep their time and speaker", input: {
      text: c.text("[04:12] Speaker 2: We keep telling people between sizes to take the medium.\n[04:20] Speaker 1: Right."), max_chars: c.int(60),
    }, expect: [
      expect.to_equal(withFilters(resp("passages"), fl.count()), c.int(2)),
      expect.to_equal(passage(0, "start_s"), c.int(252)),
      expect.to_equal(passage(0, "speaker"), c.text("Speaker 2")),
      expect.to_equal(passage(0, "text"), c.text("Speaker 2: We keep telling people between sizes to take the medium.")),
      expect.to_equal(passage(1, "start_s"), c.int(260)),
      expect.to_equal(passage(1, "speaker"), c.text("Speaker 1")),
    ] },
    { name: "plain text is timed by position", input: {
      text: c.text("One two three four five.\nSix seven eight nine ten."), max_chars: c.int(40),
    }, expect: [
      expect.to_equal(withFilters(resp("passages"), fl.count()), c.int(2)),
      expect.to_equal(passage(0, "start_s"), c.int(0)),
      // Five words before it, at 2.5 a second.
      expect.to_equal(passage(1, "start_s"), c.int(2)),
      expect.to_equal(passage(1, "speaker"), c.text("")),
      expect.to_equal(resp("duration_s"), c.int(4)),
    ] },
    { name: "schema lines take seconds or mm:ss, and gather while they fit", input: {
      lines: c.array([{ start: 0, speaker: "Speaker 1", text: "Hi there." }, { start: "1:05", speaker: "Speaker 2", text: "Hello." }, { start: 70.6, speaker: "Speaker 1", text: "" }] as never),
      max_chars: c.int(500),
    }, expect: [
      expect.to_equal(withFilters(resp("passages"), fl.count()), c.int(1)),
      expect.to_equal(passage(0, "start_s"), c.int(0)),
      expect.to_equal(passage(0, "text"), c.text("Speaker 1: Hi there.\nSpeaker 2: Hello.")),
      // The last line with words starts at 65 and has one word: 65 + 1.
      expect.to_equal(resp("duration_s"), c.int(66)),
    ] },
    { name: "a transcript with no words has no passages", input: { lines: c.array([{ start: 0, speaker: "Speaker 1", text: " " }] as never) }, expect: [
      expect.to_equal(withFilters(resp("passages"), fl.count()), c.int(0)),
      expect.to_equal(resp("duration_s"), c.int(0)),
    ] },
  ],
});
