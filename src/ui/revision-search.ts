import { InputRenderable, type KeyEvent, type RenderContext, type SelectRenderable } from "@opentui/core";
import { shortChangeId, type Bookmark, type Resolution, type Revision } from "../repository/model";
import { getTheme } from "./theme";

export function matchingRevisions(revisions: Revision[], bookmarks: Bookmark[], query: string): Revision[] {
  const needle = query.toLowerCase();
  const targets = new Set(bookmarks.filter(bookmark => `${bookmark.name}${bookmark.remote ? `@${bookmark.remote}` : ""}`.toLowerCase().includes(needle)).flatMap(bookmark => bookmark.targets));
  return revisions.filter(revision => revision.description.toLowerCase().includes(needle)
    || revision.changeId.startsWith(needle) || revision.commitId.startsWith(needle)
    || revision.bookmarks.toLowerCase().includes(needle) || revision.tags.toLowerCase().includes(needle) || targets.has(revision.commitId));
}

type Chooser = Pick<SelectRenderable, "moveUp" | "moveDown" | "focus">;

/** Adds / filtering to a chooser without taking over its accept/cancel actions. */
export class ListSearch<T> {
  readonly input: InputRenderable;
  matches: T[];
  // Called when the search input opens or closes, so the footer can switch to the search keys.
  onActiveChange?: () => void;
  private editing = false;

  constructor(ctx: RenderContext, id: string, private readonly choices: Chooser, private readonly items: T[],
    private readonly filter: (items: T[], query: string) => T[], private readonly render: (matches: T[]) => void, placeholder: string) {
    const colors = getTheme(ctx);
    this.matches = items;
    this.input = new InputRenderable(ctx, { id, visible: false, width: "100%", placeholder, textColor: colors.text, focusedTextColor: colors.text, backgroundColor: colors.panel, focusedBackgroundColor: colors.panel });
    this.input.on("input", () => {
      this.matches = this.filter(this.items, this.input.value);
      this.render(this.matches);
    });
  }

  get active() { return this.editing; }

  start() {
    this.editing = true;
    this.input.visible = true;
    this.input.focus();
    this.onActiveChange?.();
  }

  handleKey(key: KeyEvent): boolean {
    if (!this.editing) {
      if (key.name !== "/" && key.sequence !== "/") return false;
      key.preventDefault();
      this.start();
      return true;
    }
    if (key.name === "escape") {
      key.preventDefault();
      this.editing = false;
      this.input.visible = false;
      this.input.blur();
      this.input.value = "";
      this.matches = this.items;
      this.render(this.matches);
      this.choices.focus();
      this.onActiveChange?.();
      return true;
    }
    if (key.name === "return") return false;
    if (key.name === "down" || key.ctrl && key.name === "n") { key.preventDefault(); this.choices.moveDown(); }
    else if (key.name === "up" || key.ctrl && key.name === "p") { key.preventDefault(); this.choices.moveUp(); }
    return true;
  }

  dispose() { this.input.destroyRecursively(); }
}

const noMatches = "No matching destinations. Edit the search or press Escape to clear it.";
const counted = (count: number) => count ? `${count} destination${count === 1 ? "" : "s"}` : noMatches;

/**
 * Combines the text matches with what jj resolved the same query to. A single revision is listed first, since the
 * query named it exactly; several revisions or none are never offered as a destination, and the message says why.
 */
export function withResolution(query: string, resolution: Resolution, matches: Revision[], source?: Revision): { matches: Revision[]; status: string } {
  // The query is visible in the search input just above, so messages refer to it rather than repeat it.
  if (resolution.kind === "one") {
    const { revision } = resolution;
    if (revision.commitId === source?.commitId) return { matches, status: `That is the change being moved. ${matches.length ? counted(matches.length) : "Choose another destination."}` };
    return {
      matches: [revision, ...matches.filter(item => item.commitId !== revision.commitId)],
      status: `Resolves to ${shortChangeId(revision)} ${revision.description.split("\n")[0] || "(no description)"}, listed first`,
    };
  }
  const several = resolution.kind === "several" ? `${resolution.count}${resolution.more ? "+" : ""} revisions` : "";
  if (!matches.length) {
    if (resolution.kind === "none") return { matches, status: `No matching destinations. ${resolution.message}` };
    return { matches, status: `Resolves to ${several}, but a destination must be one. Narrow it, for example with latest(${query.length > 24 ? "…" : query}).` };
  }
  return { matches, status: several ? `${counted(matches.length)} by text; as a revset it names ${several}, not one` : counted(matches.length) };
}

/**
 * Searches destinations by text and also resolves the query through jj, so a bookmark, tag, change or commit ID, or
 * any revset expression can name a destination, including one the text search would not find.
 */
export class RevisionSearch extends ListSearch<Revision> {
  /** Called when an Enter that arrived while the query was still resolving can choose the selection. */
  onAccept?: () => void;
  private request = 0;
  private pending = false;
  private acceptWhenResolved = false;

  constructor(ctx: RenderContext, id: string, choices: Chooser, revisions: Revision[], bookmarks: Bookmark[],
    private readonly show: (matches: Revision[], status: string) => void,
    private readonly resolve?: (query: string) => Promise<Resolution>, private readonly source?: Revision) {
    super(ctx, id, choices, revisions, (items, query) => matchingRevisions(items, bookmarks, query),
      matches => show(matches, matches.length || !resolve || !this.input.value.trim() ? counted(matches.length) : "No text matches. Checking it as a revset…"),
      "Search text, bookmarks, tags, IDs, or type a revset");
    this.input.on("input", () => void this.lookUp(this.input.value.trim()));
  }

  private async lookUp(query: string) {
    const request = ++this.request;
    this.pending = false;
    if (!this.resolve || !query) return;
    this.pending = true;
    const text = this.matches;
    const resolution = await this.resolve(query).catch((error: unknown): Resolution => ({ kind: "none", message: error instanceof Error ? error.message : String(error) }));
    if (request !== this.request || !this.active) return;
    this.pending = false;
    const { matches, status } = withResolution(query, resolution, text, this.source);
    this.matches = matches;
    this.show(matches, status);
    const accept = this.acceptWhenResolved;
    this.acceptWhenResolved = false;
    if (accept && matches.length) this.onAccept?.();
  }

  override handleKey(key: KeyEvent): boolean {
    // Enter before the revset resolves would choose whichever text match is first, not what the query names.
    if (this.active && this.pending && key.name === "return") { key.preventDefault(); this.acceptWhenResolved = true; return true; }
    if (this.active && key.name === "escape") { ++this.request; this.pending = false; this.acceptWhenResolved = false; }
    return super.handleKey(key);
  }

  override dispose() { ++this.request; super.dispose(); }
}
