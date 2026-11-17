// Image: make one from a prompt, or edit one: attach an image and the same call edits it.
import { ASPECT_WORDS, type ModelChoices } from "@/lib/catalog";
import type { Form } from "@/lib/playground";
import { Choice, FilePick, PromptBox } from "./fields";

export type KindFieldsProps = {
  form: Form; patch: (p: Partial<Form>) => void; setting: (p: Partial<Form["settings"]>) => void;
  choices: ModelChoices; file: File | null; setFile: (f: File | null) => void;
};

export function ImageFields({ form, patch, setting, choices, file, setFile }: KindFieldsProps) {
  return (
    <>
      <PromptBox id="image-prompt" value={form.prompt} onChange={(prompt) => patch({ prompt })} useBrand={form.useBrand} onBrand={(useBrand) => patch({ useBrand })}
        placeholder={file ? "What to change, for example: make the wall warmer." : "Describe the picture: the subject, the setting, the light."} />
      <FilePick label="Image to edit" hint={file ? "This run edits it" : "Optional"} accept="image/*" file={file} onChange={setFile} testId="image-file" />
      <div className="grid grid-cols-2 gap-3">
        <Choice label="Shape" value={form.settings.aspect} options={choices.aspectRatios} onChange={(aspect) => setting({ aspect })} words={(v) => ASPECT_WORDS[v] ?? v} testId="image-aspect" />
        <Choice label="Size" value={form.settings.size} options={choices.imageSizes} onChange={(size) => setting({ size })} testId="image-size" />
      </div>
    </>
  );
}
