//! A long-lived, read-only process that embeds jj. `PROTOCOL.md` is the contract.
//!
//! `CliRunner` supplies everything that makes output match the CLI: config loading, aliases, the template engine and
//! the graph renderer. Everything from jj is `Rc`-based, which is why the protocol is serial.

mod config_watch;
mod requests;
mod template_ext;

use std::io::BufRead as _;
use std::io::Write as _;
use std::panic::AssertUnwindSafe;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use futures::FutureExt as _;
use jj_cli::cli_util::CliRunner;
use jj_cli::cli_util::CommandHelper;
use jj_cli::cli_util::WorkspaceCommandHelper;
use jj_cli::command_error::CommandError;
use jj_cli::command_error::user_error;
use jj_cli::ui::Ui;
use jj_lib::config::StackedConfig;
use jj_lib::object_id::ObjectId as _;
use jj_lib::op_heads_store::OpHeadsStore;
use jj_lib::op_store::OperationId;
use serde_json::Value;

use crate::config_watch::ConfigWatch;

const PROTOCOL_VERSION: u32 = 1;
/// Must follow the `jj-cli` pin in `Cargo.toml`. jj-cli doesn't export the version it was built as.
const JJ_VERSION: &str = "0.45.1";
/// `EX_TEMPFAIL`: the client should respawn the helper and retry.
const EXIT_CONFIG_CHANGED: i32 = 75;

/// Set once `serve` has taken over reporting, so `main` knows whether the protocol still needs a failure header.
static STARTUP_REPORTED: AtomicBool = AtomicBool::new(false);

#[derive(clap::Parser, Clone, Debug)]
enum HelperCommand {
    /// Answer read requests on stdin until it closes. See PROTOCOL.md.
    Serve,
}

fn main() -> ExitCode {
    let status = CliRunner::init()
        .name("jj-evolved-helper")
        .add_commit_template_extension(Box::new(template_ext::HelperTemplates))
        .add_subcommand(serve)
        .add_dispatch_hook(async |ui, command, serve_or_jj| {
            // The runner brings every jj command with it, including the ones that write. Only `serve` is reachable.
            if command.matches().subcommand_name() == Some("serve") {
                serve_or_jj.call(ui, command).await
            } else {
                Err(user_error("jj-evolved-helper only supports the `serve` command"))
            }
        })
        .run();
    // Argument, config and repository errors happen before dispatch, and jj has already printed them to stderr.
    if status != 0 && !STARTUP_REPORTED.load(Ordering::Relaxed) {
        let _ = write_startup_failure(&format!("jj exited with status {status} before serving"));
    }
    status.into()
}

fn write_startup_failure(error: &str) -> std::io::Result<()> {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{{\"ready\":false,\"error\":{},\"len\":0}}", json_string(error))?;
    stdout.flush()
}

fn json_string(text: &str) -> String {
    Value::from(text).to_string()
}

fn error_text(error: &CommandError) -> String {
    error.error.to_string()
}

async fn serve(_ui: &mut Ui, command: &CommandHelper, _subcommand: HelperCommand) -> Result<(), CommandError> {
    let mut server = match Server::new(command) {
        Ok(server) => server,
        Err(error) => {
            STARTUP_REPORTED.store(true, Ordering::Relaxed);
            let _ = write_startup_failure(&error_text(&error));
            return Err(error);
        }
    };
    STARTUP_REPORTED.store(true, Ordering::Relaxed);
    server.run().await;
    Ok(())
}

struct Server<'a> {
    command: &'a CommandHelper,
    /// Plain text with no stderr output. Warnings aren't part of the contract, and nothing is obliged to read stderr.
    ui: Ui,
    op_heads_store: Arc<dyn OpHeadsStore>,
    config: ConfigWatch,
    /// The view, index and short-prefix context of one operation. Kept while that operation stays the head.
    workspace_command: Option<WorkspaceCommandHelper>,
}

impl<'a> Server<'a> {
    fn new(command: &'a CommandHelper) -> Result<Self, CommandError> {
        check_launch_flags(command)?;
        // Before anything loads: an edit made from here on is seen by the first stat.
        let config = ConfigWatch::new(command)?;
        let workspace = command.load_workspace()?;
        Ok(Self {
            command,
            ui: Ui::null(),
            op_heads_store: workspace.repo_loader().op_heads_store().clone(),
            config,
            workspace_command: None,
        })
    }

    async fn run(&mut self) {
        let mut stdout = std::io::stdout().lock();
        let mut stdin = std::io::stdin().lock();
        let ready = format!(
            "{{\"ready\":true,\"jjVersion\":{},\"protocol\":{PROTOCOL_VERSION},\"len\":0}}\n",
            json_string(JJ_VERSION)
        );
        if write_response(&mut stdout, &ready, &[]).is_err() {
            return;
        }
        let mut line = Vec::new();
        loop {
            line.clear();
            // A line with no newline means the client went away while writing it.
            if !(stdin.read_until(b'\n', &mut line).is_ok() && line.ends_with(b"\n")) {
                return;
            }
            if self.config.changed() {
                std::process::exit(EXIT_CONFIG_CHANGED);
            }
            let (header, payload) = self.answer(&line).await;
            if write_response(&mut stdout, &header, &payload).is_err() {
                return;
            }
        }
    }

    async fn answer(&mut self, line: &[u8]) -> (String, Vec<u8>) {
        let request: Value = serde_json::from_slice(line).unwrap_or(Value::Null);
        let id = request.get("id").filter(|id| id.is_i64() || id.is_u64()).cloned().unwrap_or(Value::Null);
        if id.is_null() {
            return (failure_header(&id, "request is not a JSON object with an integer id"), Vec::new());
        }
        // Rendering is buffered, so a panic can't leave a partial response on stdout.
        let mut payload = Vec::with_capacity(64 * 1024);
        let result = AssertUnwindSafe(self.handle(&request, &mut payload)).catch_unwind().await;
        let failure = match result {
            Ok(Ok(())) => return (format!("{{\"id\":{id},\"ok\":true,\"len\":{}}}\n", payload.len()), payload),
            Ok(Err(error)) => error_text(&error),
            Err(panic) => {
                // The cached state may have been mid-update.
                self.workspace_command = None;
                let message = panic.downcast_ref::<String>().map(String::as_str);
                let message = message.or_else(|| panic.downcast_ref::<&str>().copied());
                format!("panic: {}", message.unwrap_or("unknown"))
            }
        };
        (failure_header(&id, &failure), Vec::new())
    }

    async fn handle(&mut self, request: &Value, output: &mut Vec<u8>) -> Result<(), CommandError> {
        let head = self.single_op_head().await?;
        let explicit_op = match request.get("op") {
            None | Some(Value::Null) => None,
            Some(Value::String(op)) if op == "@" => None,
            Some(Value::String(op)) if *op == head.hex() => Some(op),
            Some(_) => return Err(user_error("op is not the current head operation")),
        };
        let kind = text_field(request, "kind")?;
        if kind == "opId" {
            output.extend_from_slice(head.hex().as_bytes());
            return Ok(());
        }
        self.load_workspace_at(&head).await?;
        let ui = &self.ui;
        let workspace_command = self.workspace_command.as_ref().expect("loaded above");
        // Another process can move the head between reading it and loading. `@` follows it, a named operation can't.
        if explicit_op.is_some() && *workspace_command.repo().op_id() != head {
            return Err(user_error("op is not the current head operation"));
        }
        match kind {
            "log" => {
                let limit = optional_limit(request)?;
                let graph = request.get("graph").and_then(Value::as_bool).ok_or_else(|| missing("graph"))?;
                let revset = text_field(request, "revset")?;
                let template = text_field(request, "template")?;
                requests::log(ui, workspace_command, output, revset, template, limit, graph).await
            }
            "diff" => {
                let commit_id = text_field(request, "commitId")?;
                let paths = request.get("paths").and_then(Value::as_array).ok_or_else(|| missing("paths"))?;
                let paths: Vec<String> = paths
                    .iter()
                    .map(|path| path.as_str().map(str::to_owned).ok_or_else(|| missing("paths")))
                    .collect::<Result<_, _>>()?;
                requests::diff(ui, workspace_command, output, commit_id, &paths).await
            }
            "files" => {
                let commit_id = text_field(request, "commitId")?;
                requests::files(ui, workspace_command, output, commit_id, text_field(request, "template")?).await
            }
            "bookmarks" => requests::bookmarks(ui, workspace_command, output, text_field(request, "template")?).await,
            "tags" => requests::tags(ui, workspace_command, output, text_field(request, "template")?).await,
            "remotes" => requests::remotes(workspace_command, output).await,
            _ => Err(user_error(format!("unknown request kind: {kind}"))),
        }
    }

    /// A directory listing: no lock, no write, and it never reconciles divergent heads.
    async fn single_op_head(&self) -> Result<OperationId, CommandError> {
        let mut heads = self.op_heads_store.get_op_heads().await.map_err(|error| user_error(error.to_string()))?;
        match (heads.pop(), heads.is_empty()) {
            (Some(head), true) => Ok(head),
            _ => Err(user_error("the repository has more than one head operation")),
        }
    }

    async fn load_workspace_at(&mut self, head: &OperationId) -> Result<(), CommandError> {
        if self.workspace_command.as_ref().is_some_and(|cached| cached.repo().op_id() == head) {
            return Ok(());
        }
        // Free the old index before loading the new one.
        self.workspace_command = None;
        self.workspace_command = Some(self.command.workspace_helper_no_snapshot(&self.ui).await?);
        Ok(())
    }
}

/// `workspace_helper_no_snapshot` is read-only only because of these flags: without `--at-op=@` it would merge divergent
/// operations, and without `--ignore-working-copy` a later call could treat the workspace as writable.
fn check_launch_flags(command: &CommandHelper) -> Result<(), CommandError> {
    let args = command.global_args();
    if !args.ignore_working_copy || args.at_operation.as_deref() != Some("@") {
        return Err(user_error("serve requires --ignore-working-copy and --at-op=@"));
    }
    if command.settings().get_bool("ui.log-word-wrap")? {
        return Err(user_error("serve requires --config ui.log-word-wrap=false"));
    }
    // `--when.commands` scopes resolved for `serve` here, and for the real command under the CLI.
    let config_env = command.config_env();
    let resolved_for = |name: Option<&str>| -> Result<Vec<String>, CommandError> {
        let mut config_env = config_env.clone();
        if let Some(name) = name {
            config_env.set_command_name(name.to_owned());
        }
        Ok(layers_text(&config_env.resolve_config(command.raw_config())?))
    };
    let served = resolved_for(None)?;
    for name in ["log", "diff", "bookmark list", "op log", "tag list", "git remote list"] {
        if resolved_for(Some(name))? != served {
            return Err(user_error(format!("config scoped to `{name}` with --when.commands can't be served")));
        }
    }
    Ok(())
}

fn layers_text(config: &StackedConfig) -> Vec<String> {
    config.layers().iter().map(|layer| layer.data.to_string()).collect()
}

fn write_response(stdout: &mut impl std::io::Write, header: &str, payload: &[u8]) -> std::io::Result<()> {
    stdout.write_all(header.as_bytes())?;
    stdout.write_all(payload)?;
    stdout.flush()
}

fn failure_header(id: &Value, error: &str) -> String {
    format!("{{\"id\":{id},\"ok\":false,\"error\":{},\"len\":0}}\n", json_string(error))
}

fn missing(field: &str) -> CommandError {
    user_error(format!("missing or invalid field: {field}"))
}

fn text_field<'r>(request: &'r Value, field: &str) -> Result<&'r str, CommandError> {
    request.get(field).and_then(Value::as_str).ok_or_else(|| missing(field))
}

fn optional_limit(request: &Value) -> Result<Option<usize>, CommandError> {
    match request.get("limit") {
        None | Some(Value::Null) => Ok(None),
        Some(limit) => {
            let limit = limit.as_u64().and_then(|limit| usize::try_from(limit).ok());
            limit.map(Some).ok_or_else(|| missing("limit"))
        }
    }
}
