import { InputRenderable, type KeyEvent, type RenderContext, type SelectRenderable } from "@opentui/core";
import type { Bookmark, Revision } from "../repository/model";
import { getTheme } from "./theme";

export function matchingRevisions(revisions: Revision[], bookmarks: Bookmark[], query: string): Revision[] {
  const needle = query.toLowerCase();
  const targets = new Set(bookmarks.filter(bookmark => `${bookmark.name}${bookmark.remote ? `@${bookmark.remote}` : ""}`.toLowerCase().includes(needle)).flatMap(bookmark => bookmark.targets));
  return revisions.filter(revision => revision.description.toLowerCase().includes(needle)
    || revision.changeId.startsWith(needle) || revision.commitId.startsWith(needle)
    || revision.bookmarks.toLowerCase().includes(needle) || targets.has(revision.commitId));
}

/** Adds / filtering to a revision chooser without taking over its accept/cancel actions. */
export class RevisionSearch {
  readonly input: InputRenderable;
  matches: Revision[];
  private editing = false;

  constructor(ctx: RenderContext, id: string, private readonly choices: SelectRenderable,
    private readonly revisions: Revision[], private readonly bookmarks: Bookmark[],
    private readonly render: (matches: Revision[]) => void) {
    const colors = getTheme(ctx);
    this.matches = revisions;
    this.input = new InputRenderable(ctx, { id, visible: false, width: "100%", placeholder: "Search descriptions, bookmarks or ID prefixes", textColor: colors.text, focusedTextColor: colors.text, backgroundColor: colors.panel, focusedBackgroundColor: colors.panel });
    this.input.on("input", () => {
      this.matches = matchingRevisions(this.revisions, this.bookmarks, this.input.value);
      this.render(this.matches);
    });
  }

  start() {
    this.editing = true;
    this.input.visible = true;
    this.input.focus();
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
      this.matches = this.revisions;
      this.render(this.matches);
      this.choices.focus();
      return true;
    }
    if (key.name === "return") return false;
    if (key.name === "down" || key.ctrl && key.name === "n") { key.preventDefault(); this.choices.moveDown(); }
    else if (key.name === "up" || key.ctrl && key.name === "p") { key.preventDefault(); this.choices.moveUp(); }
    return true;
  }

  dispose() { this.input.destroyRecursively(); }
}
