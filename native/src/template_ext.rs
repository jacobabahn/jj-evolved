//! Template methods that only the helper has. Each is a faster spelling of an expression plain jj already has, with
//! byte-identical output, so the client can send one to the helper and the other to its CLI fallback. `PROTOCOL.md`
//! lists the pairs, and `tests/fidelity.rs` compares each pair's output.
//!
//! The names carry a `jj_evolved_` prefix so that no jj method or user alias can shadow or be shadowed by them.

use jj_cli::commit_templater::CommitTemplateBuildFnTable;
use jj_cli::commit_templater::CommitTemplateLanguageExtension;
use jj_cli::templater::TemplatePropertyExt as _;
use jj_lib::extensions_map::ExtensionsMap;
use jj_lib::object_id::ObjectId as _;

pub struct HelperTemplates;

impl CommitTemplateLanguageExtension for HelperTemplates {
    fn build_fn_table<'repo>(&self) -> CommitTemplateBuildFnTable<'repo> {
        let mut table = CommitTemplateBuildFnTable::empty();
        // `added_targets.map(|c| c.commit_id())` loads every target commit just to print its ID, about 5.6 µs each:
        // 280 ms for 50,000 remote bookmarks. The IDs are already in the view. `json()` prints both as the same array
        // of full hex IDs, in the same order.
        table.commit_ref_methods.insert(
            "jj_evolved_added_target_ids",
            |_language, _diagnostics, _build_context, self_property, function| {
                function.expect_no_arguments()?;
                let out_property = self_property
                    .map(|commit_ref| commit_ref.target().added_ids().map(|id| id.hex()).collect::<Vec<String>>());
                Ok(out_property.into_dyn_wrapped())
            },
        );
        table
    }

    fn build_cache_extensions(&self, _extensions: &mut ExtensionsMap) {}
}
