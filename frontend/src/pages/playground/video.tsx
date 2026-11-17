// Video: a clip from a prompt, optionally starting from an image. Lengths, shapes and resolutions are the model's own.
import { useId } from "react";
import { Input } from "@/components/ui/input";
import { ASPECT_WORDS } from "@/lib/catalog";
import { Choice, Field, FilePick, PromptBox, SwitchField } from "./fields";
import type { KindFieldsProps } from "./image";

export function VideoFields({ form, patch, setting, choices, file, setFile }: KindFieldsProps) {
  const avoid = useId();
  return (
    <>
      <PromptBox id="video-prompt" value={form.prompt} onChange={(prompt) => patch({ prompt })} useBrand={form.useBrand} onBrand={(useBrand) => patch({ useBrand })}
        placeholder="Describe the clip: what moves, the light, the camera." />
      <Field label="Leave out" hint="Optional" htmlFor={avoid}>
        <Input id={avoid} value={form.negative} onChange={(e) => patch({ negative: e.target.value })} placeholder="people, text, logos" className="h-8 text-body" />
      </Field>
      <FilePick label="First frame" hint="Optional" accept="image/*" file={file} onChange={setFile} testId="video-file" />
      <div className="grid grid-cols-2 gap-3">
        <Choice label="Length" value={form.settings.seconds} options={choices.durations} onChange={(seconds) => setting({ seconds })} words={(v) => `${v} s`} testId="video-seconds" />
        <Choice label="Shape" value={form.settings.aspect} options={choices.aspectRatios} onChange={(aspect) => setting({ aspect })} words={(v) => ASPECT_WORDS[v] ?? v} testId="video-aspect" />
        <Choice label="Resolution" value={form.settings.resolution} options={choices.resolutions} onChange={(resolution) => setting({ resolution })} words={(v) => (v === "4k" ? "4K" : v)} testId="video-resolution" />
        <SwitchField label="Sound" on={form.settings.audio} onChange={(audio) => setting({ audio })} words={["Silent", "With sound"]} testId="video-audio" />
      </div>
    </>
  );
}
