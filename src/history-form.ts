import { InputRenderable, ScrollBoxRenderable, SelectRenderable, TextRenderable, type KeyEvent, type RenderContext } from "@opentui/core";
import { TreeComparisonView } from "./tree-comparison";
import { ActionOverlay } from "./action-overlay";
import { Repository, terminalText, type ChangedFile, type Mutation, type PreparedMutation, type Revision } from "./repository";

type Draft =
  | { kind: "rebase"; descendants: boolean }
  | { kind: "squash"; files: string[]; description: string; keepDescription: boolean };
type Mode =
  | { kind: "fields" }
  | { kind: "destination"; revisions: Revision[] }
  | { kind: "files"; files: ChangedFile[]; selected: Set<string> }
  | { kind: "description" };

export class HistoryForm extends ActionOverlay {
  private readonly controls: SelectRenderable;
  private readonly choices: SelectRenderable;
  private readonly input: InputRenderable;
  private readonly preview: ScrollBoxRenderable;
  private readonly text: TextRenderable;
  private readonly comparison: TreeComparisonView;
  private destination: Revision | null = null;
  private mode: Mode = { kind: "fields" };
  private prepared: PreparedMutation | null = null;
  private generation = 0;
  private disposed = false;
  private applying = false;
  private loadingField = false;
  private fieldRequest = 0;

  constructor(ctx: RenderContext, private readonly repository: Repository, private readonly source: Revision,
    private readonly draft: Draft, private readonly apply: (prepared: PreparedMutation) => Promise<void>) {
    super(ctx, "history-form");
    this.title = draft.kind === "rebase" ? " Rebase change " : " Squash changes ";
    this.context.content = terminalText(`Source ${source.changeId.slice(0, 8)} / ${source.commitId.slice(0, 12)}\n${source.description.split("\n")[0] || "(no description)"}`);
    this.controls = new SelectRenderable(ctx, { id: "history-fields", height: draft.kind === "rebase" ? 3 : 4, flexShrink: 0, showDescription: false, wrapSelection: true, backgroundColor: "#15212c", focusedBackgroundColor: "#15212c", selectedBackgroundColor: "#294a51", textColor: "#d6e2eb", focusedTextColor: "#d6e2eb" });
    this.choices = new SelectRenderable(ctx, { id: "history-choices", flexGrow: 1, width: "100%", visible: false, showDescription: false, backgroundColor: "#15212c", focusedBackgroundColor: "#15212c", textColor: "#d6e2eb", focusedTextColor: "#d6e2eb" });
    this.input = new InputRenderable(ctx, { id: "history-description", visible: false, textColor: "#d6e2eb", backgroundColor: "#294a51" });
    this.preview = new ScrollBoxRenderable(ctx, { id: "history-preview", flexGrow: 1, minHeight: 1, border: true, title: " Preview ", borderColor: "#344958" });
    this.text = new TextRenderable(ctx, { id: "history-preview-text", content: "Choose a destination to preview the result.", fg: "#d6e2eb", wrapMode: "word", flexShrink: 0 });
    this.fields.add(this.controls);
    this.fields.add(this.input);
    this.comparison = new TreeComparisonView(ctx, "history-trees");
    this.preview.add(this.comparison);
    this.preview.add(this.text);
    this.body.add(this.choices);
    this.body.add(this.preview);
    this.renderFields();
  }

  private renderFields() {
    if (this.disposed) return;
    const index = this.controls.getSelectedIndex();
    const destination = this.destination ? `${this.destination.changeId.slice(0, 8)} ${this.destination.description.split("\n")[0] || "(no description)"}` : "Choose a revision";
    const labels = [`Destination: ${destination}`];
    if (this.draft.kind === "rebase") labels.push(`Scope: ${this.draft.descendants ? "Change and descendants" : "Only this change"}`);
    else labels.push(`Files: ${this.draft.files.length ? `${this.draft.files.length} selected` : "All changed files"}`, `Description: ${this.draft.keepDescription ? "Keep destination description" : this.draft.description || "(empty)"}`);
    labels.push(`Apply ${this.draft.kind}`);
    this.controls.options = labels.map(name => ({ name: terminalText(name), description: "" }));
    this.controls.setSelectedIndex(Math.max(0, index));
    this.hints.content = "j/k move  Enter edit/apply  Esc close  p preview  PgUp/Dn";
    this.controls.focus();
  }

  private mutation(): Mutation | null {
    if (!this.destination) return null;
    return this.draft.kind === "rebase"
      ? { kind: "rebase", revision: this.source, destination: this.destination, descendants: this.draft.descendants }
      : { kind: "squash", revision: this.source, destination: this.destination, files: this.draft.files, description: this.draft.keepDescription ? this.destination.description : this.draft.description };
  }

  private async updatePreview() {
    const generation = ++this.generation;
    this.prepared = null;
    this.comparison.setTrees(null);
    this.text.content = "Choose a destination to preview the result.";
    const action = this.mutation();
    if (!action) { this.report("Choose a destination first.", true); return; }
    this.report("Preparing preview…");
    this.text.content = "Preparing tree comparison…";
    try {
      const prepared = await this.repository.prepare(action);
      if (this.disposed || generation !== this.generation) return;
      this.prepared = prepared;
      this.comparison.setTrees(prepared.trees);
      this.text.content = prepared.summary;
      this.preview.scrollTo(0);
      this.report("Preview ready. Review it, then select Apply.");
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.report(error instanceof Error ? error.message : String(error), true);
    }
  }

  private returnToFields() {
    this.mode = { kind: "fields" };
    this.choices.visible = false;
    this.input.visible = false;
    this.preview.visible = true;
    this.choices.blur();
    this.input.blur();
    this.renderFields();
  }

  private async editField() {
    const request = ++this.fieldRequest;
    const index = this.controls.getSelectedIndex();
    if (index === this.controls.options.length - 1) { await this.submit(); return; }
    if (index === 0) {
      this.report("Loading destinations…");
      const snapshot = await this.repository.snapshot("all()");
      if (this.disposed || request !== this.fieldRequest) return;
      const revisions = snapshot.revisions.filter(item => item.commitId !== this.source.commitId);
      this.mode = { kind: "destination", revisions };
      this.choices.options = revisions.map(item => ({ name: `${item.changeId.slice(0, 8)} ${terminalText(item.description.split("\n")[0] || "(no description)")}`, description: "" }));
    } else if (this.draft.kind === "rebase") {
      this.draft.descendants = !this.draft.descendants;
      this.renderFields();
      await this.updatePreview();
      return;
    } else if (index === 1) {
      const files = await this.repository.files(this.source);
      if (this.disposed || request !== this.fieldRequest) return;
      this.mode = { kind: "files", files, selected: new Set(this.draft.files) };
      this.renderFiles();
    } else {
      this.mode = { kind: "description" };
      this.input.value = this.draft.keepDescription ? "" : this.draft.description;
      this.input.visible = true;
      this.input.focus();
      this.hints.content = "Enter save description  Ctrl-D keep destination text  Esc back";
      return;
    }
    this.report("");
    this.choices.setSelectedIndex(0);
    this.choices.visible = true;
    this.preview.visible = false;
    this.choices.focus();
    this.hints.content = "j/k choose  Enter select  Esc back to form";
  }

  private renderFiles() {
    if (this.mode.kind !== "files") return;
    const mode = this.mode;
    this.choices.options = [
      { name: "Use all files", description: "" },
      { name: `Use ${mode.selected.size} selected files`, description: "" },
      ...mode.files.map(file => ({ name: `${mode.selected.has(file.path) ? "[x]" : "[ ]"} ${terminalText(file.path)}`, description: "" })),
    ];
  }

  private choose() {
    const index = this.choices.getSelectedIndex();
    if (this.mode.kind === "destination") {
      const destination = this.mode.revisions[index];
      if (!destination) return;
      this.destination = destination;
    } else if (this.mode.kind === "files" && this.draft.kind === "squash") {
      if (index > 1) {
        const file = this.mode.files[index - 2];
        if (!file) return;
        this.mode.selected.has(file.path) ? this.mode.selected.delete(file.path) : this.mode.selected.add(file.path);
        this.renderFiles();
        this.choices.setSelectedIndex(index);
        return;
      }
      if (index === 1 && !this.mode.selected.size) { this.report("Select a file or choose Use all files.", true); return; }
      this.draft.files = index === 0 ? [] : [...this.mode.selected];
    }
    this.returnToFields();
    void this.updatePreview();
  }

  private async submit() {
    if (!this.prepared) { await this.updatePreview(); return; }
    this.applying = true;
    this.report(`Applying ${this.draft.kind}…`);
    try { await this.apply(this.prepared); }
    catch (error) {
      if (!this.disposed) {
        this.prepared = null;
        this.report(`${error instanceof Error ? error.message : String(error)} Press p to review again.`, true);
      }
    } finally { this.applying = false; }
  }

  handleKey(key: KeyEvent): "close" | "handled" {
    if (this.applying) { key.preventDefault(); return "handled"; }
    if (key.name === "escape") {
      key.preventDefault();
      ++this.fieldRequest;
      if (this.mode.kind === "fields") return "close";
      this.returnToFields();
      return "handled";
    }
    if (this.loadingField) { key.preventDefault(); return "handled"; }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault(); this.preview.scrollBy(key.name === "pageup" ? -5 : 5); return "handled";
    }
    if (this.mode.kind === "description") {
      if (this.draft.kind === "squash" && (key.name === "return" || key.ctrl && key.name === "d")) {
        key.preventDefault();
        this.draft.keepDescription = key.ctrl;
        this.draft.description = this.input.value;
        this.returnToFields();
        void this.updatePreview();
      }
      return "handled";
    }
    key.preventDefault();
    const list = this.mode.kind === "fields" ? this.controls : this.choices;
    if (key.name === "j" || key.name === "down" || key.name === "tab") list.moveDown();
    else if (key.name === "k" || key.name === "up") list.moveUp();
    else if (key.name === "p" && this.mode.kind === "fields") void this.updatePreview();
    else if (key.name === "return") {
      if (this.mode.kind === "fields") {
        this.loadingField = true;
        void this.editField().catch(error => { if (!this.disposed) this.report(error instanceof Error ? error.message : String(error), true); }).finally(() => { this.loadingField = false; });
      }
      else this.choose();
    }
    return "handled";
  }

  dispose() { if (this.disposed) return; this.disposed = true; ++this.generation; this.destroyRecursively(); }
}
