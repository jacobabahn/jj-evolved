import type { Action } from "../ui/keybindings";
import { RevisionSearch } from "../ui/revision-search";
import { MutationReview } from "./mutation-review";
import { getTheme, themeScrollbars } from "../ui/theme";
import { highlightJjText, revisionPrefixes } from "../ui/jj-highlighting";
import { ChangePreview } from "../preview/change-preview";
import { InputRenderable, ScrollBoxRenderable, SelectRenderable, type KeyEvent, type RenderContext } from "@opentui/core";
import { TreeComparisonView } from "./tree-comparison";
import { ActionOverlay } from "../ui/action-overlay";
import { fitText } from "../ui/ellipsis-text";
import { Repository } from "../repository/repository";
import { terminalText } from "../terminal-text";
import { shortChangeId, rebaseScopeSummary, rebaseTargets, rebaseTargetName, type ChangedFile, type Mutation, type RebaseTarget, type Revision } from "../repository/model";

type Draft =
  | { kind: "rebase"; descendants: boolean; target?: RebaseTarget }
  | { kind: "squash"; files: string[]; description: string; keepDescription: boolean };
/** A row of the form. A between rebase has two boundaries: destination, which it goes after, and insertBefore. */
type Field = "target" | "destination" | "insertBefore" | "scope" | "files" | "description" | "apply";
type Boundary = "destination" | "insertBefore";
type Mode =
  | { kind: "fields" }
  | { kind: "destination"; revisions: Revision[]; boundary: Boundary }
  | { kind: "files"; files: ChangedFile[]; selected: Set<string> }
  | { kind: "description" };

export class HistoryForm extends ActionOverlay {
  private readonly controls: SelectRenderable;
  private readonly choices: SelectRenderable;
  private readonly input: InputRenderable;
  private readonly preview: ScrollBoxRenderable;
  private readonly text: ChangePreview;
  private readonly comparison: TreeComparisonView;
  private destinationSearch: RevisionSearch | null = null;
  private destination: Revision | null = null;
  // Kept while another target is chosen, so switching back to between restores it.
  private secondBoundary: Revision | null = null;
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
    this.controls = new SelectRenderable(ctx, { id: "history-fields", height: this.fieldList().length, flexShrink: 0, showDescription: false, wrapSelection: true, backgroundColor: getTheme(this.ctx).panel, focusedBackgroundColor: getTheme(this.ctx).panel, selectedBackgroundColor: getTheme(this.ctx).selected, textColor: getTheme(this.ctx).text, focusedTextColor: getTheme(this.ctx).text, selectedTextColor: getTheme(this.ctx).selectedText, selectedDescriptionColor: getTheme(this.ctx).selectedText });
    this.choices = new SelectRenderable(ctx, { id: "history-choices", height: 0, minHeight: 1, flexGrow: 1, width: "100%", visible: false, showDescription: false, backgroundColor: getTheme(this.ctx).panel, focusedBackgroundColor: getTheme(this.ctx).panel, textColor: getTheme(this.ctx).text, focusedTextColor: getTheme(this.ctx).text, selectedBackgroundColor: getTheme(this.ctx).selected, selectedTextColor: getTheme(this.ctx).selectedText, selectedDescriptionColor: getTheme(this.ctx).selectedText });
    this.input = new InputRenderable(ctx, { id: "history-description", visible: false, textColor: getTheme(this.ctx).text, backgroundColor: getTheme(this.ctx).selected, focusedBackgroundColor: getTheme(this.ctx).panel, focusedTextColor: getTheme(this.ctx).text, placeholderColor: getTheme(this.ctx).muted });
    this.preview = new ScrollBoxRenderable(ctx, { id: "history-preview", flexGrow: 1, minHeight: 1, wrapperOptions: { flexBasis: 0 }, contentOptions: { width: "100%", minHeight: 0 }, marginTop: 1, border: false });
    themeScrollbars(this.preview, "panel");
    this.text = new ChangePreview(ctx, "history-preview-text", "Choose a destination to preview the result.");
    this.fields.add(this.controls);
    this.fields.add(this.input);
    this.comparison = new TreeComparisonView(ctx, "history-trees");
    this.preview.add(this.comparison);
    this.preview.add(this.text);
    this.body.add(this.choices);
    this.body.add(this.preview);
    this.renderFields();
    // The list opens on the destination; the rebase target sits above it.
    this.controls.setSelectedIndex(this.fieldList().indexOf("destination"));
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

  private get target(): RebaseTarget { return this.draft.kind === "rebase" ? this.draft.target ?? "onto" : "onto"; }

  private fieldList(): Field[] {
    if (this.draft.kind === "squash") return ["destination", "files", "description", "apply"];
    return ["target", "destination", ...(this.target === "between" ? ["insertBefore" as const] : []), "scope", "apply"];
  }

  /** What the form calls a boundary: Destination for onto, the insert for before and after, After and Before for between. */
  private boundaryName(boundary: Boundary) {
    if (boundary === "insertBefore") return "Before";
    return { onto: "Destination", before: "Insert before", after: "Insert after", between: "After" }[this.target];
  }

  private renderFields() {
    if (this.disposed) return;
    const fields = this.fieldList();
    const index = this.controls.getSelectedIndex();
    const name = (revision: Revision | null) => revision ? `${revision.changeId.slice(0, 8)} ${revision.description.split("\n")[0] || "(no description)"}` : "Choose a revision";
    const labels = fields.map(field => {
      switch (field) {
        case "target": return `Target: ${rebaseTargetName(this.target)}`;
        case "destination": return `${this.boundaryName("destination")}: ${name(this.destination)}`;
        case "insertBefore": return `${this.boundaryName("insertBefore")}: ${name(this.secondBoundary)}`;
        case "scope": return `Scope: ${this.draft.kind === "rebase" && this.draft.descendants ? `Change and descendants (${this.scope ? this.scope.length + " changes" : "loading…"})` : "Only this change"}`;
        case "files": return `Files: ${this.draft.kind === "squash" && this.draft.files.length ? `${this.draft.files.length} selected` : "All changed files"}`;
        case "description": return `Description: ${this.draft.kind === "squash" && !this.draft.keepDescription ? this.draft.description || "(empty)" : "Keep destination description"}`;
        case "apply": return `Apply ${this.draft.kind}`;
      }
    });
    this.controls.height = labels.length;
    this.controls.options = labels.map(name => ({ name: terminalText(name), description: "" }));
    this.controls.setSelectedIndex(Math.min(Math.max(0, index), labels.length - 1));
    this.keys = { left: [["j/k", "move"], ["Enter", "edit/apply"], ...(this.draft.kind === "rebase" ? [["m", `target: ${this.target}`] as [string, string]] : []), ["p", "preview"], ["PgDn/PgUp", "scroll preview"]], right: [["Esc", "close"]] };
    this.controls.focus();
  }

  /** Moves to the next rebase target, keeping the scope, both boundaries and the rest of the draft. */
  private async cycleTarget() {
    if (this.draft.kind !== "rebase") return;
    const selected = this.fieldList()[this.controls.getSelectedIndex()];
    this.draft.target = rebaseTargets[(rebaseTargets.indexOf(this.target) + 1) % rebaseTargets.length];
    this.renderFields();
    // The cursor stays on the same row, even when the second boundary appears or goes above it.
    const index = selected ? this.fieldList().indexOf(selected) : -1;
    if (index >= 0) this.controls.setSelectedIndex(index);
    await this.updatePreview();
  }

  private missing(): string | null {
    if (!this.destination) return this.target === "between" ? "Choose the revision to insert after first." : "Choose a destination first.";
    if (this.target === "between" && !this.secondBoundary) return "Choose the revision to insert before.";
    return null;
  }

  private mutation(): Mutation | null {
    if (!this.destination || this.missing()) return null;
    return this.draft.kind === "rebase"
      ? { kind: "rebase", revision: this.source, destination: this.destination, descendants: this.draft.descendants,
        ...(this.target === "onto" ? {} : { target: this.target }), ...(this.target === "between" && this.secondBoundary ? { insertBefore: this.secondBoundary } : {}) }
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
      if (!action) { this.review.cancel(); this.text.content = this.scopeText(); this.report(this.missing() ?? "Choose a destination first."); return; }
      this.text.content = "Preparing tree comparison…";
      const prepared = await this.review.prepare(action);
      if (!prepared) return;
      this.comparison.setTrees(prepared.trees, this.draft.kind);
      this.text.prefixes = revisionPrefixes([this.source, ...[this.destination, this.target === "between" ? this.secondBoundary : null].filter(item => item !== null)]);
      this.text.content = prepared.summary;
      this.preview.scrollTo(0);
      this.report("Preview ready. Review it, then select Apply.");
    } catch (error) {
      if (!this.disposed) this.report(error instanceof Error ? error.message : String(error), true);
    }
  }

  private returnToFields() {
    this.destinationSearch?.dispose();
    this.destinationSearch = null;
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
    const field = this.fieldList()[this.controls.getSelectedIndex()];
    if (field === "apply") { await this.submit(); return; }
    if (field === "target") { await this.cycleTarget(); return; }
    if (field === "destination" || field === "insertBefore") {
      const boundary = field;
      this.report("Loading destinations…");
      const [candidates, bookmarks] = await Promise.all([this.repository.navigationRevisions("all()"), this.repository.bookmarks()]);
      if (this.disposed || request !== this.fieldRequest) return;
      const revisions = candidates.filter(item => item.commitId !== this.source.commitId);
      this.mode = { kind: "destination", revisions, boundary };
      const choosing = this.draft.kind === "rebase" && this.target !== "onto" ? ` for ${this.boundaryName(boundary).toLowerCase()}` : "";
      const render = (matches: Revision[], status = `${matches.length} destinations${choosing}`) => {
        this.mode = { kind: "destination", revisions: matches, boundary };
        this.choices.options = matches.map(item => ({ name: this.fit(`${item.changeId.slice(0, 8)} ${terminalText(item.description.split("\n")[0] || "(no description)")}`), description: "" }));
        this.choices.setSelectedIndex(0);
        this.report(status, !matches.length);
      };
      render(revisions);
      this.destinationSearch = new RevisionSearch(this.ctx, "history-destination-search", this.choices, revisions, bookmarks, render,
        query => this.repository.resolve(query), this.source);
      this.destinationSearch.onAccept = () => this.choose();
      this.destinationSearch.onActiveChange = () => this.showChoiceKeys();
      this.fields.add(this.destinationSearch.field);
    } else if (this.draft.kind === "rebase") {
      // The scope is the only other rebase field.
      this.draft.descendants = !this.draft.descendants;
      this.renderFields();
      await this.updatePreview();
      return;
    } else if (field === "files") {
      const files = await this.repository.files(this.source);
      if (this.disposed || request !== this.fieldRequest) return;
      this.mode = { kind: "files", files, selected: new Set(this.draft.files) };
      this.renderFiles();
    } else {
      this.mode = { kind: "description" };
      this.input.value = this.draft.keepDescription ? "" : this.draft.description;
      this.input.visible = true;
      this.input.focus();
      this.keys = { left: [["Enter", "save description"], ["^D", "keep destination text"]], right: [["Esc", "back"]] };
      return;
    }
    if (this.mode.kind !== "destination") this.report("");
    this.choices.setSelectedIndex(0);
    this.choices.visible = true;
    this.preview.visible = false;
    this.choices.focus();
    this.showChoiceKeys();
  }

  private showChoiceKeys() {
    this.keys = this.destinationSearch?.active
      ? { left: [["^N/^P", "choose"], ["Enter", "select"]], right: [["Esc", "clear"]] }
      : this.mode.kind === "destination"
        ? { left: [["j/k", "choose"], ["Enter", "select"], ["/", "search all destinations"]], right: [["Esc", "back"]] }
        : { left: [["j/k", "choose"], ["Enter", "select"]], right: [["Esc", "back to form"]] };
  }

  private renderFiles() {
    if (this.mode.kind !== "files") return;
    const mode = this.mode;
    this.choices.options = [
      { name: "Use all files", description: "" },
      { name: `Use ${mode.selected.size} selected files`, description: "" },
      ...mode.files.map(file => ({ name: this.fit(`${mode.selected.has(file.path) ? "[x]" : "[ ]"} ${terminalText(file.path)}`), description: "" })),
    ];
  }

  // The list draws its rows itself, after a column of padding and the "▶ " indicator, so they are cut here by the
  // same rule as other text.
  private fit(text: string) { return fitText(text, this.innerWidth - 3); }

  private choose() {
    const index = this.choices.getSelectedIndex();
    if (this.mode.kind === "destination") {
      const destination = this.mode.revisions[index];
      if (!destination) return;
      if (this.mode.boundary === "insertBefore") this.secondBoundary = destination;
      else this.destination = destination;
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

  /** True while keys go to text: the destination search or the squash description. */
  get typing() { return !!this.destinationSearch?.active || this.mode.kind === "description"; }

  /** `action` is what the key runs in the menu bindings, when it runs one. */
  handleKey(key: KeyEvent, action?: Action): "close" | "handled" {
    if (this.review.applying) { key.preventDefault(); return "handled"; }
    if (!this.loadingField && this.destinationSearch?.handleKey(key)) return "handled";
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
    if (action === "down" || key.name === "down" || key.name === "tab") list.moveDown();
    else if (action === "up" || key.name === "up") list.moveUp();
    else if (key.name === "p" && this.mode.kind === "fields") void this.updatePreview();
    else if (key.name === "m" && this.mode.kind === "fields" && this.draft.kind === "rebase") void this.cycleTarget();
    else if (key.name === "return") {
      if (this.mode.kind === "fields") {
        this.loadingField = true;
        void this.editField().catch(error => { if (!this.disposed) this.report(error instanceof Error ? error.message : String(error), true); }).finally(() => { this.loadingField = false; });
      }
      else this.choose();
    }
    return "handled";
  }

  dispose() { if (this.disposed) return; this.disposed = true; this.destinationSearch?.dispose(); this.review.cancel(); this.destroyRecursively(); }
}
