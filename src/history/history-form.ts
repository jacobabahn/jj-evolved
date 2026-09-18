import { MutationReview } from "./mutation-review";
import { getTheme } from "../ui/theme";
import { highlightJjText, revisionPrefixes } from "../ui/jj-highlighting";
import { ChangePreview } from "../preview/change-preview";
import { InputRenderable, ScrollBoxRenderable, SelectRenderable, type KeyEvent, type RenderContext } from "@opentui/core";
import { TreeComparisonView } from "./tree-comparison";
import { ActionOverlay } from "../ui/action-overlay";
import { Repository } from "../repository/repository";
import { terminalText } from "../terminal-text";
import { shortChangeId, rebaseScopeSummary, type ChangedFile, type Mutation, type Revision } from "../repository/model";

type Draft =
  | { kind: "rebase"; descendants: boolean }
  | { kind: "squash"; files: string[]; description: string; keepDescription: boolean };
type Mode =
  | { kind: "fields" }
  | { kind: "destination"; revisions: Revision[]; all: Revision[]; searching: boolean }
  | { kind: "files"; files: ChangedFile[]; selected: Set<string> }
  | { kind: "description" };

export class HistoryForm extends ActionOverlay {
  private readonly controls: SelectRenderable;
  private readonly choices: SelectRenderable;
  private readonly input: InputRenderable;
  private readonly preview: ScrollBoxRenderable;
  private readonly text: ChangePreview;
  private readonly comparison: TreeComparisonView;
  private destination: Revision | null = null;
  private mode: Mode = { kind: "fields" };
  private disposed = false;
  private loadingField = false;
  private fieldRequest = 0;
  private scope: Revision[] | null = null;
  private scopeRequest = 0;
  private previewRequest = 0;

  constructor(ctx: RenderContext, private readonly repository: Repository, private readonly source: Revision,
    private readonly draft: Draft, private readonly review: MutationReview, private readonly apply: () => Promise<void>,
    private readonly scopeChanged: (revisions: Revision[]) => void = () => {}) {
    super(ctx, "history-form");
    this.title = draft.kind === "rebase" ? " Rebase change " : " Squash changes ";
    this.context.content = highlightJjText(`Source ${shortChangeId(source)} / ${source.commitId.slice(0, 12)}\n${source.description.split("\n")[0] || "(no description)"}`, revisionPrefixes([source]), getTheme(this.ctx));
    this.controls = new SelectRenderable(ctx, { id: "history-fields", height: draft.kind === "rebase" ? 3 : 4, flexShrink: 0, showDescription: false, wrapSelection: true, backgroundColor: getTheme(this.ctx).panel, focusedBackgroundColor: getTheme(this.ctx).panel, selectedBackgroundColor: getTheme(this.ctx).selected, textColor: getTheme(this.ctx).text, focusedTextColor: getTheme(this.ctx).text, selectedTextColor: getTheme(this.ctx).selectedText, selectedDescriptionColor: getTheme(this.ctx).selectedText });
    this.choices = new SelectRenderable(ctx, { id: "history-choices", height: 0, minHeight: 1, flexGrow: 1, width: "100%", visible: false, showDescription: false, backgroundColor: getTheme(this.ctx).panel, focusedBackgroundColor: getTheme(this.ctx).panel, textColor: getTheme(this.ctx).text, focusedTextColor: getTheme(this.ctx).text, selectedBackgroundColor: getTheme(this.ctx).selected, selectedTextColor: getTheme(this.ctx).selectedText, selectedDescriptionColor: getTheme(this.ctx).selectedText });
    this.input = new InputRenderable(ctx, { id: "history-description", visible: false, textColor: getTheme(this.ctx).text, backgroundColor: getTheme(this.ctx).selected, focusedBackgroundColor: getTheme(this.ctx).panel, focusedTextColor: getTheme(this.ctx).text, placeholderColor: getTheme(this.ctx).muted });
    this.input.on("input", () => {
      if (this.mode.kind !== "destination" || !this.mode.searching) return;
      const query = this.input.value.toLocaleLowerCase().trim();
      this.mode.revisions = this.mode.all.filter(item => `${item.changeId} ${item.commitId} ${item.description} ${item.bookmarks}`.toLocaleLowerCase().includes(query));
      this.renderDestinations();
    });
    this.preview = new ScrollBoxRenderable(ctx, { id: "history-preview", flexGrow: 1, minHeight: 1, contentOptions: { width: "100%", minHeight: 0 }, border: true, title: " Preview ", borderColor: getTheme(this.ctx).border });
    this.text = new ChangePreview(ctx, "history-preview-text", "Choose a destination to preview the result.");
    this.fields.add(this.controls);
    this.fields.add(this.input);
    this.comparison = new TreeComparisonView(ctx, "history-trees");
    this.preview.add(this.comparison);
    this.preview.add(this.text);
    this.body.add(this.choices);
    this.body.add(this.preview);
    this.renderFields();
    if (draft.kind === "rebase") void this.loadScope().catch(error => {
      if (!this.disposed) this.report(error instanceof Error ? error.message : String(error), true);
    });
  }

  private scopeText() {
    return this.draft.kind === "rebase" && this.draft.descendants
      ? this.scope ? rebaseScopeSummary(this.scope) : "Loading descendants…"
      : "Choose a destination to preview the result.";
  }

  private async loadScope() {
    if (this.draft.kind !== "rebase") return;
    const request = ++this.scopeRequest;
    const scope = await this.repository.rebaseScope(this.source);
    if (this.disposed || request !== this.scopeRequest) return;
    this.scope = scope;
    this.scopeChanged(this.draft.descendants ? scope : [this.source]);
    if (this.mode.kind === "fields") this.renderFields();
    if (!this.destination) this.text.content = this.scopeText();
  }

  private renderFields() {
    if (this.disposed) return;
    const index = this.controls.getSelectedIndex();
    const destination = this.destination ? `${this.destination.changeId.slice(0, 8)} ${this.destination.description.split("\n")[0] || "(no description)"}` : "Choose a revision";
    const labels = [`Destination: ${destination}`];
    if (this.draft.kind === "rebase") labels.push(`Scope: ${this.draft.descendants ? `Change and descendants (${this.scope ? this.scope.length + " changes" : "loading…"})` : "Only this change"}`);
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
    const request = ++this.previewRequest;
    this.review.cancel();
    this.comparison.setTrees(null);
    this.text.content = this.scopeText();
    this.report("Preparing preview…");
    try {
      await this.loadScope();
      if (this.disposed || request !== this.previewRequest) return;
      const action = this.mutation();
      if (!action) { this.review.cancel(); this.text.content = this.scopeText(); this.report("Choose a destination first."); return; }
      this.text.content = "Preparing tree comparison…";
      const prepared = await this.review.prepare(action);
      if (!prepared) return;
      this.comparison.setTrees(prepared.trees, this.draft.kind);
      this.text.prefixes = revisionPrefixes([this.source, ...(this.destination ? [this.destination] : [])]);
      this.text.content = prepared.summary;
      this.preview.scrollTo(0);
      this.report("Preview ready. Review it, then select Apply.");
    } catch (error) {
      if (!this.disposed) this.report(error instanceof Error ? error.message : String(error), true);
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
      const candidates = await this.repository.navigationRevisions("all()");
      if (this.disposed || request !== this.fieldRequest) return;
      const revisions = candidates.filter(item => item.commitId !== this.source.commitId);
      this.mode = { kind: "destination", revisions, all: revisions, searching: false };
      this.renderDestinations();
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
      this.input.placeholder = "Description";
      this.input.value = this.draft.keepDescription ? "" : this.draft.description;
      this.input.visible = true;
      this.input.focus();
      this.hints.content = "Enter save description  Ctrl-D keep destination text  Esc back";
      return;
    }
    if (this.mode.kind !== "destination") this.report("");
    this.choices.setSelectedIndex(0);
    this.choices.visible = true;
    this.preview.visible = false;
    this.choices.focus();
    this.hints.content = this.mode.kind === "destination"
      ? "j/k choose  Enter select  / search all destinations  Esc back"
      : "j/k choose  Enter select  Esc back to form";
  }

  private renderDestinations() {
    if (this.mode.kind !== "destination") return;
    this.choices.options = this.mode.revisions.map(item => ({ name: `${item.changeId.slice(0, 8)} ${terminalText(item.description.split("\n")[0] || "(no description)")}`, description: "" }));
    this.choices.setSelectedIndex(0);
    this.report(`${this.mode.revisions.length} destinations${this.mode.revisions.length ? "" : " · No matching revisions"}`);
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
    if (!this.review.ready) { await this.updatePreview(); return; }
    this.report(`Applying ${this.draft.kind}…`);
    try { await this.apply(); }
    catch (error) {
      if (!this.disposed) {
        this.report(`${error instanceof Error ? error.message : String(error)} Press p to review again.`, true);
      }
    }
  }

  handleKey(key: KeyEvent): "close" | "handled" {
    if (this.review.applying) { key.preventDefault(); return "handled"; }
    if (this.mode.kind === "destination" && this.mode.searching) {
      if (key.name === "escape") {
        key.preventDefault();
        this.mode.searching = false;
        this.mode.revisions = this.mode.all;
        this.input.visible = false; this.input.blur(); this.choices.focus();
        this.hints.content = "j/k choose  Enter select  / search all destinations  Esc back";
        this.renderDestinations();
      } else if (key.name === "return") { key.preventDefault(); this.choose(); }
      else if (key.name === "down") { key.preventDefault(); this.choices.moveDown(); }
      else if (key.name === "up") { key.preventDefault(); this.choices.moveUp(); }
      return "handled";
    }
    if (this.mode.kind === "destination" && key.sequence === "/") {
      key.preventDefault();
      this.mode.searching = true;
      this.input.value = "";
      this.input.placeholder = "Search descriptions, bookmarks or IDs";
      this.input.visible = true; this.choices.blur(); this.input.focus();
      this.hints.content = "Type to search all destinations  ↑/↓ choose  Enter select  Esc clear";
      return "handled";
    }
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

  dispose() { if (this.disposed) return; this.disposed = true; this.review.cancel(); this.destroyRecursively(); }
}
