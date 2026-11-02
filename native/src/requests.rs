//! The read requests. Each mirrors a jj-cli command, which is `pub(crate)`, so this is copied from the source with only
//! the options the protocol never uses taken out. Keep them close to the originals when moving to a new jj version:
//!
//! - [`log`] follows `commands/log.rs` (`cmd_log`)
//! - [`diff`] and [`files`] follow `commands/diff.rs` (`cmd_diff`)
//! - [`bookmarks`] follows `commands/bookmark/list.rs` (`cmd_bookmark_list`)
//!
//! What was dropped, because it only ever reaches stderr, is the warnings about unmatched paths and the hints.

use std::collections::HashSet;
use std::rc::Rc;

use clap::Parser as _;
use futures::StreamExt as _;
use futures::TryStreamExt as _;
use futures::future::try_join_all;
use futures::stream::LocalBoxStream;
use indexmap::IndexSet;
use itertools::Itertools as _;
use jj_cli::cli_util::LogContentFormat;
use jj_cli::cli_util::RevisionArg;
use jj_cli::cli_util::WorkspaceCommandHelper;
use jj_cli::cli_util::format_template;
use jj_cli::cli_util::short_commit_hash;
use jj_cli::command_error::CommandError;
use jj_cli::command_error::user_error;
use jj_cli::commit_ref_list;
use jj_cli::commit_ref_list::RefFilterPredicates;
use jj_cli::commit_templater::CommitRef;
use jj_cli::commit_templater::TreeDiffEntry;
use jj_cli::diff_util::DiffFormatArgs;
use jj_cli::diff_util::get_copy_records;
use jj_cli::diff_util::show_templated;
use jj_cli::formatter::FormatterExt as _;
use jj_cli::graphlog::GraphStyle;
use jj_cli::graphlog::get_graphlog;
use jj_cli::templater::TemplateRenderer;
use jj_cli::ui::Ui;
use jj_lib::backend::CommitId;
use jj_lib::commit::Commit;
use jj_lib::copies::CopyRecords;
use jj_lib::graph::GraphEdge;
use jj_lib::graph::GraphEdgeType;
use jj_lib::graph::TopoGroupedGraph;
use jj_lib::matchers::Matcher;
use jj_lib::merge::Diff;
use jj_lib::merged_tree::MergedTree;
use jj_lib::repo::Repo as _;
use jj_lib::revset::RevsetEvaluationError;
use jj_lib::revset::RevsetStreamExt as _;
use jj_lib::rewrite::merge_commit_trees;
use jj_lib::str_util::StringExpression;

pub async fn log(
    ui: &Ui,
    workspace_command: &WorkspaceCommandHelper,
    output: &mut Vec<u8>,
    revset_text: &str,
    template_text: &str,
    limit: Option<usize>,
    graphical: bool,
) -> Result<(), CommandError> {
    let settings = workspace_command.settings();
    let revset_expression = workspace_command.parse_union_revsets(ui, &[RevisionArg::from(revset_text.to_owned())])?;
    let revset = revset_expression.evaluate()?;

    let repo = workspace_command.repo();

    let prio_revset = {
        let text = settings.get_string("revsets.log-graph-prioritize")?;
        let mut prio_revset = workspace_command.parse_revset(ui, &RevisionArg::from(text))?;
        // Resolve the query within a separate scope so its visibility and
        // referenced commits aren't affected by the prioritize expression:
        // `<prio> & at_operation(@, <query>)`
        let query_expr = revset_expression.expression().within_visibility(repo.as_ref());
        prio_revset.intersect_with(&query_expr);
        prio_revset
    };

    let store = repo.store();
    let graph_style = GraphStyle::from_settings(settings)?;

    let use_elided_nodes = settings.get_bool("ui.log-synthetic-elided-nodes")?;
    let with_content_format = LogContentFormat::new(ui, settings)?;

    let template: TemplateRenderer<Commit>;
    let node_template: TemplateRenderer<Option<Commit>>;
    {
        let language = workspace_command.commit_template_language();
        template = workspace_command.parse_template(ui, &language, template_text)?.labeled(["log", "commit"]);
        node_template = workspace_command
            .parse_template(ui, &language, &settings.get_string("templates.log_node")?)?
            .labeled(["log", "commit", "node"]);
    }

    let mut formatter = ui.new_formatter(output);
    let formatter = formatter.as_mut();

    if graphical {
        let mut raw_output = formatter.raw()?;
        let mut graph = get_graphlog(graph_style, raw_output.as_mut());
        let mut stream: LocalBoxStream<_> = {
            let mut topo_order = TopoGroupedGraph::new(revset.stream_graph(), |id| id);

            let mut prio_stream = prio_revset.evaluate_to_commit_ids()?;
            while let Some(prio) = prio_stream.try_next().await? {
                topo_order.prioritize_branch(prio);
            }
            let forward_stream = topo_order.stream();

            // The input to TopoGroupedGraph shouldn't be truncated because the prioritized
            // commit must exist in the input set.
            forward_stream.take(limit.unwrap_or(usize::MAX)).boxed_local()
        };
        while let Some((commit_id, edges)) = stream.try_next().await? {
            // The graph is keyed by (CommitId, is_synthetic)
            let mut graphlog_edges = vec![];
            let mut missing_edge_id = None;
            let mut elided_targets = vec![];
            for edge in edges {
                match edge.edge_type {
                    GraphEdgeType::Missing => {
                        missing_edge_id = Some(edge.target);
                    }
                    GraphEdgeType::Direct => {
                        graphlog_edges.push(GraphEdge::direct((edge.target, false)));
                    }
                    GraphEdgeType::Indirect => {
                        if use_elided_nodes {
                            elided_targets.push(edge.target.clone());
                            graphlog_edges.push(GraphEdge::direct((edge.target, true)));
                        } else {
                            graphlog_edges.push(GraphEdge::indirect((edge.target, false)));
                        }
                    }
                }
            }
            if let Some(missing_edge_id) = missing_edge_id {
                graphlog_edges.push(GraphEdge::missing((missing_edge_id, false)));
            }
            let mut buffer = vec![];
            let key = (commit_id, false);
            let commit = store.get_commit_async(&key.0).await?;
            let within_graph = with_content_format.sub_width(graph.width(&key, &graphlog_edges));
            within_graph
                .write(ui.new_formatter(&mut buffer).as_mut(), async |formatter| template.format(&commit, formatter))
                .await?;

            let commit = Some(commit);
            let node_symbol = format_template(ui, &commit, &node_template);
            graph.add_node(&key, &graphlog_edges, &node_symbol, &String::from_utf8_lossy(&buffer))?;

            for elided_target in elided_targets {
                let elided_key = (elided_target, true);
                let real_key = (elided_key.0.clone(), false);
                let edges = [GraphEdge::direct(real_key)];
                let mut buffer = vec![];
                let within_graph = with_content_format.sub_width(graph.width(&elided_key, &edges));
                within_graph
                    .write(ui.new_formatter(&mut buffer).as_mut(), async |formatter| {
                        writeln!(formatter.labeled("elided"), "(elided revisions)")
                    })
                    .await?;
                let node_symbol = format_template(ui, &None, &node_template);
                graph.add_node(&elided_key, &edges, &node_symbol, &String::from_utf8_lossy(&buffer))?;
            }
        }
    } else {
        let id_stream: LocalBoxStream<Result<CommitId, RevsetEvaluationError>> =
            revset.stream().take(limit.unwrap_or(usize::MAX)).boxed_local();
        let mut commit_stream = id_stream.commits(store);
        while let Some(commit) = commit_stream.try_next().await? {
            with_content_format.write(formatter, async |formatter| template.format(&commit, formatter)).await?;
        }
    }
    Ok(())
}

/// The trees `jj diff -r <revision>` compares, and the copies between them.
async fn revision_diff(
    ui: &Ui,
    workspace_command: &WorkspaceCommandHelper,
    revision: &str,
    matcher: &dyn Matcher,
) -> Result<(MergedTree, MergedTree, CopyRecords), CommandError> {
    let repo = workspace_command.repo();
    let revisions_evaluator = workspace_command.parse_union_revsets(ui, &[RevisionArg::from(revision.to_owned())])?;
    let target_expression = revisions_evaluator.expression();
    let mut gaps_revset = workspace_command
        .attach_revset_evaluator(target_expression.roots().range(&target_expression.heads()).minus(target_expression))
        .evaluate_to_commit_ids()?;
    if let Some(commit_id) = gaps_revset.try_next().await? {
        return Err(user_error(format!(
            "Cannot diff revsets with gaps in: revision {} would need to be in the set.",
            short_commit_hash(&commit_id)
        )));
    }
    let heads: Vec<_> = workspace_command
        .attach_revset_evaluator(target_expression.heads())
        .evaluate_to_commits()?
        .try_collect()
        .await?;
    let roots: Vec<_> = workspace_command
        .attach_revset_evaluator(target_expression.roots())
        .evaluate_to_commits()?
        .try_collect()
        .await?;

    // Collect parents outside of revset to preserve parent order
    let parents: IndexSet<_> = try_join_all(roots.iter().map(|c| c.parents())).await?.into_iter().flatten().collect();
    let parents = parents.into_iter().collect_vec();
    let from_tree = merge_commit_trees(repo.as_ref(), &parents).await?;
    let to_tree = merge_commit_trees(repo.as_ref(), &heads).await?;

    let mut copy_records = CopyRecords::default();
    for p in &parents {
        for to in &heads {
            let records = get_copy_records(repo.store(), p.id(), to.id(), matcher).await?;
            copy_records.add_records(records);
        }
    }
    Ok((from_tree, to_tree, copy_records))
}

#[derive(clap::Parser)]
struct DiffFormatCli {
    #[command(flatten)]
    format: DiffFormatArgs,
}

pub async fn diff(
    ui: &Ui,
    workspace_command: &WorkspaceCommandHelper,
    output: &mut Vec<u8>,
    revision: &str,
    paths: &[String],
) -> Result<(), CommandError> {
    let fileset_expression = workspace_command.parse_file_patterns(ui, paths)?;
    let matcher = fileset_expression.to_matcher();
    let (from_tree, to_tree, copy_records) = revision_diff(ui, workspace_command, revision, matcher.as_ref()).await?;
    // `DiffFormatArgs` has private fields, so parsing `--git` is the only way to build one.
    let format = DiffFormatCli::try_parse_from(["diff", "--git"]).map_err(|err| user_error(err.to_string()))?.format;
    let diff_renderer = workspace_command.diff_renderer_for(&format)?;
    diff_renderer
        .show_diff(
            ui,
            ui.new_formatter(output).as_mut(),
            Diff::new(&from_tree, &to_tree),
            matcher.as_ref(),
            &copy_records,
            ui.term_width(),
        )
        .await?;
    Ok(())
}

pub async fn files(
    ui: &Ui,
    workspace_command: &WorkspaceCommandHelper,
    output: &mut Vec<u8>,
    revision: &str,
    template_text: &str,
) -> Result<(), CommandError> {
    let fileset_expression = workspace_command.parse_file_patterns(ui, &[])?;
    let matcher = fileset_expression.to_matcher();
    let (from_tree, to_tree, copy_records) = revision_diff(ui, workspace_command, revision, matcher.as_ref()).await?;
    let language = workspace_command.commit_template_language();
    let template: TemplateRenderer<TreeDiffEntry> =
        workspace_command.parse_template(ui, &language, template_text)?.labeled(["diff"]);
    let tree_diff = from_tree.diff_stream_with_copies(&to_tree, matcher.as_ref(), &copy_records);
    show_templated(ui.new_formatter(output).as_mut(), tree_diff, &template).await?;
    Ok(())
}

/// `bookmark list --all-remotes -T <template>`.
pub async fn bookmarks(
    ui: &Ui,
    workspace_command: &WorkspaceCommandHelper,
    output: &mut Vec<u8>,
    template_text: &str,
) -> Result<(), CommandError> {
    let repo = workspace_command.repo();
    let view = repo.view();

    let template: TemplateRenderer<Rc<CommitRef>> = {
        let language = workspace_command.commit_template_language();
        workspace_command.parse_template(ui, &language, template_text)?.labeled(["bookmark_list"])
    };

    let predicates = RefFilterPredicates {
        name_matcher: StringExpression::all().to_matcher(),
        remote_matcher: StringExpression::all().to_matcher(),
        matched_local_targets: HashSet::new(),
        conflicted: false,
        include_local_only: true,
        include_synced_remotes: true,
        include_untracked_remotes: true,
    };
    let mut bookmark_list_items = commit_ref_list::collect_items(view.bookmarks(), &predicates);
    let sort_keys =
        workspace_command.settings().get_value_with("ui.bookmark-list-sort-keys", commit_ref_list::parse_sort_keys)?;
    commit_ref_list::sort(repo.store(), &mut bookmark_list_items, &sort_keys)?;

    let mut formatter = ui.new_formatter(output);
    bookmark_list_items
        .iter()
        .flat_map(|item| itertools::chain([&item.primary], &item.tracked))
        .try_for_each(|commit_ref| template.format(commit_ref, formatter.as_mut()))?;
    Ok(())
}
