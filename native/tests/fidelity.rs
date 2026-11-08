//! Differential tests: every request goes to the helper and to real `jj`, and the bytes must match.
//!
//! `bench_repos` also runs against the benchmark repositories when `JJ_EVOLVED_BENCH_ROOT` is set, for example:
//!
//!     JJ_EVOLVED_BENCH_ROOT=/var/tmp/jj-evolved-bench.492LQl JJ_EVOLVED_BENCH_REPOS=jj,git,rust \
//!       cargo test --release --test fidelity bench_repos -- --nocapture

use std::collections::BTreeMap;
use std::fs;
use std::io::BufRead as _;
use std::io::BufReader;
use std::io::Read as _;
use std::io::Write as _;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::ChildStdin;
use std::process::ChildStdout;
use std::process::Command;
use std::process::Stdio;

use serde_json::Value;
use serde_json::json;
use tempfile::TempDir;

/// `REVISION_TEMPLATE` in `src/repository/log-snapshot.ts`.
const REVISION_TEMPLATE: &str = r#"'{'
  ++ '"commitId":' ++ json(commit_id)
  ++ ',"changeId":' ++ json(change_id)
  ++ ',"changePrefix":' ++ json(change_id.shortest().prefix())
  ++ ',"description":' ++ json(description)
  ++ ',"author":' ++ json(author.name())
  ++ ',"bookmarks":' ++ json(stringify(bookmarks))
  ++ ',"parents":' ++ json(parents.map(|p| p.commit_id()))
  ++ ',"workingCopy":' ++ json(current_working_copy)
  ++ ',"conflict":' ++ json(conflict)
  ++ '}
'"#;
/// `bookmarks()` in `src/repository/repository.ts`.
const BOOKMARK_TEMPLATE: &str = r#"'[' ++ json(name) ++ ',' ++ json(if(remote, stringify(remote), "")) ++ ',' ++ json(added_targets.map(|c| c.commit_id())) ++ ',' ++ json(conflict) ++ ',' ++ json(tracked) ++ if(remote && tracked, ',' ++ json(tracking_behind_count.lower()) ++ ',' ++ json(tracking_ahead_count.lower())) ++ ']
'"#;
/// What `bookmarks()` sends the helper: [`BOOKMARK_TEMPLATE`] with the helper-only spelling of the targets.
fn helper_bookmark_template() -> String {
    BOOKMARK_TEMPLATE.replace("added_targets.map(|c| c.commit_id())", "jj_evolved_added_target_ids")
}
/// `files()` in `src/repository/repository.ts`.
const FILES_TEMPLATE: &str = r#"'[' ++ json(path) ++ ',' ++ json(status) ++ ']
'"#;
/// A built-in template, which leans on labels, aliases and config.
const BUILTIN_TEMPLATE: &str = "builtin_log_compact";

fn log_template() -> String {
    format!("{REVISION_TEMPLATE} ++ '::jj-evolved-description::\n'")
}

/// `revsetSymbols()` in `src/repository/repository.ts`.
const TAG_TEMPLATE: &str = r#"if(!remote, json(name) ++ "\n")"#;

/// The base environment of a fixture or bench run. Never inherits the user's jj config.
#[derive(Clone)]
struct JjEnv {
    root: PathBuf,
    vars: Vec<(String, String)>,
    /// Extra `--config` values, passed to both sides.
    config: Vec<String>,
}

impl JjEnv {
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new("jj");
        command.current_dir(&self.root).args(["--no-pager", "--color=never"]);
        for value in &self.config {
            command.args(["--config", value]);
        }
        command.args(args).envs(self.vars.iter().map(|(k, v)| (k, v))).env("JJ_INTERACTIVE", "0");
        command
    }

    /// Runs `jj` and returns stdout. A failure here is a broken test, not a fidelity result.
    fn jj(&self, args: &[&str]) -> Vec<u8> {
        let output = self.command(args).output().unwrap();
        assert!(output.status.success(), "jj {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        output.stdout
    }

    fn jj_text(&self, args: &[&str]) -> String {
        String::from_utf8(self.jj(args)).unwrap()
    }

    fn spawn(&self) -> Helper {
        Helper::spawn(self, &[])
    }
}

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

struct Response {
    ok: bool,
    error: Option<String>,
    payload: Vec<u8>,
}

impl Helper {
    fn spawn(env: &JjEnv, extra_args: &[&str]) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_jj-evolved-helper"));
        command
            .current_dir(&env.root)
            .arg("--repository")
            .arg(&env.root)
            .args(["--ignore-working-copy", "--at-op=@", "--no-pager", "--color=never"])
            .args(["--config", "ui.log-word-wrap=false"]);
        for value in &env.config {
            command.args(["--config", value]);
        }
        command
            .args(extra_args)
            .arg("serve")
            .envs(env.vars.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let mut helper = Self { child, stdin, stdout, next_id: 0 };
        let ready = helper.read_header().expect("no ready header");
        assert_eq!(ready["ready"], true, "{ready}");
        assert_eq!(ready["jjVersion"], "0.45.1");
        assert_eq!(ready["protocol"], 1);
        assert_eq!(ready["len"], 0);
        helper
    }

    fn read_header(&mut self) -> Option<Value> {
        let mut line = String::new();
        (self.stdout.read_line(&mut line).unwrap() > 0).then(|| serde_json::from_str(&line).unwrap())
    }

    fn send(&mut self, mut request: Value) -> u64 {
        self.next_id += 1;
        request["id"] = json!(self.next_id);
        let mut line = request.to_string();
        line.push('\n');
        self.stdin.as_mut().unwrap().write_all(line.as_bytes()).unwrap();
        self.next_id
    }

    fn request(&mut self, request: Value) -> Response {
        let id = self.send(request);
        let header = self.read_header().expect("helper closed its stdout");
        assert_eq!(header["id"], id, "{header}");
        let mut payload = vec![0; header["len"].as_u64().unwrap() as usize];
        self.stdout.read_exact(&mut payload).unwrap();
        let ok = header["ok"].as_bool().unwrap();
        Response { ok, error: header["error"].as_str().map(str::to_owned), payload }
    }

    /// Sends a request the helper must decline, so that the client falls back on the CLI.
    fn assert_declined(&mut self, request: Value) -> String {
        let response = self.request(request.clone());
        assert!(!response.ok, "expected ok:false for {request}");
        assert!(response.payload.is_empty());
        response.error.expect("ok:false needs an error")
    }

    fn close_and_wait(mut self) -> i32 {
        self.stdin = None;
        self.child.wait().unwrap().code().unwrap()
    }
}

/// Reports the first difference rather than both payloads, which can be huge.
fn assert_same_bytes(label: &str, helper: &[u8], cli: &[u8]) {
    if helper == cli {
        return;
    }
    let at = helper.iter().zip(cli).position(|(a, b)| a != b).unwrap_or(helper.len().min(cli.len()));
    let window = |bytes: &[u8]| {
        String::from_utf8_lossy(&bytes[at.saturating_sub(120)..(at + 120).min(bytes.len())]).into_owned()
    };
    panic!(
        "{label}: payload differs at byte {at} (helper {} bytes, cli {} bytes)\n--- helper\n{}\n--- cli\n{}",
        helper.len(),
        cli.len(),
        window(helper),
        window(cli)
    );
}

/// The `jj` argv the protocol pairs with a request.
fn cli_args(request: &Value) -> Vec<String> {
    let string = |key: &str| request[key].as_str().unwrap().to_owned();
    let strings = |items: &[&str]| items.iter().map(|&s| s.to_owned()).collect::<Vec<_>>();
    match request["kind"].as_str().unwrap() {
        "opId" => {
            strings(&["--ignore-working-copy", "--at-op=@", "op", "log", "--no-graph", "--limit", "1", "-T", "id"])
        }
        "log" => {
            let op = request.get("op").and_then(Value::as_str).unwrap_or("@");
            // Before the subcommand with any other --config: clap keeps only the occurrences after it.
            let mut args = strings(&["--config", "ui.log-word-wrap=false", "--ignore-working-copy"]);
            args.push(format!("--at-op={op}"));
            args.push("log".to_owned());
            if request["graph"] == false {
                args.push("--no-graph".to_owned());
            }
            if let Some(limit) = request.get("limit") {
                args.extend(["--limit".to_owned(), limit.to_string()]);
            }
            args.extend(["-r".to_owned(), string("revset"), "-T".to_owned(), string("template")]);
            args
        }
        "diff" => {
            let mut args = strings(&["--ignore-working-copy", "--at-op=@", "diff", "--revision"]);
            args.extend([string("commitId"), "--git".to_owned(), "--".to_owned()]);
            args.extend(request["paths"].as_array().unwrap().iter().map(|path| path.as_str().unwrap().to_owned()));
            args
        }
        "files" => {
            let mut args = strings(&["--ignore-working-copy", "diff", "-r"]);
            args.extend([string("commitId"), "-T".to_owned(), string("template")]);
            args
        }
        "bookmarks" => {
            let mut args = strings(&["--ignore-working-copy", "--at-op=@", "bookmark", "list", "--all-remotes", "-T"]);
            args.push(string("template"));
            args
        }
        "tags" => {
            let mut args = strings(&["--ignore-working-copy", "--at-op=@", "tag", "list", "-T"]);
            args.push(string("template"));
            args
        }
        "remotes" => strings(&["--ignore-working-copy", "git", "remote", "list"]),
        kind => panic!("unknown kind {kind}"),
    }
}

/// Sends `request` to the helper, twice so the cached path is covered, and compares with the CLI.
fn assert_matches_cli(env: &JjEnv, helper: &mut Helper, request: Value) {
    let args = cli_args(&request);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let cli = env.command(&args).output().unwrap();
    assert!(cli.status.success(), "jj {args:?}: {}", String::from_utf8_lossy(&cli.stderr));
    for pass in ["first", "second"] {
        let response = helper.request(request.clone());
        assert!(response.ok, "{pass} {request}: {:?}", response.error);
        assert_same_bytes(&format!("{pass} {request}"), &response.payload, &cli.stdout);
    }
}

/// For a request whose template uses a helper-only method: the helper answers `request`, the CLI runs `cli_request`.
fn assert_pair_matches_cli(env: &JjEnv, helper: &mut Helper, request: Value, cli_request: Value) {
    let args = cli_args(&cli_request);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let cli = env.command(&args).output().unwrap();
    assert!(cli.status.success(), "jj {args:?}: {}", String::from_utf8_lossy(&cli.stderr));
    for pass in ["first", "second"] {
        let response = helper.request(request.clone());
        assert!(response.ok, "{pass} {request}: {:?}", response.error);
        assert_same_bytes(&format!("{pass} {request}"), &response.payload, &cli.stdout);
    }
}

struct Fixture {
    _dir: TempDir,
    env: JjEnv,
    dir: PathBuf,
}

impl Fixture {
    fn empty() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let jj_config = base.join("user-config.toml");
        fs::write(
            &jj_config,
            r#"
[user]
name = "Tëst Üser"
email = "test@example.com"
[revset-aliases]
'described(x)' = 'description(substring:x)'
'recent()' = 'ancestors(visible_heads(), 3)'
[template-aliases]
'shout(x)' = 'x.upper()'
[remotes.origin]
auto-track-bookmarks = "*"
"#,
        )
        .unwrap();
        let repo = base.join("repo");
        fs::create_dir(&repo).unwrap();
        let vars = vec![
            ("HOME".to_owned(), base.join("home").display().to_string()),
            ("XDG_CONFIG_HOME".to_owned(), base.join("xdg").display().to_string()),
            ("JJ_CONFIG".to_owned(), jj_config.display().to_string()),
        ];
        let env = JjEnv { root: repo, vars, config: vec![] };
        env.jj(&["git", "init", "."]);
        Self { _dir: dir, env, dir: base }
    }

    fn write(&self, path: &str, content: impl AsRef<[u8]>) {
        let path = self.env.root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn commit(&self, message: &str) -> String {
        self.env.jj(&["commit", "-m", message]);
        self.id("@-")
    }

    fn id(&self, revision: &str) -> String {
        self.env.jj_text(&["--ignore-working-copy", "log", "--no-graph", "-r", revision, "-T", "commit_id"])
    }

    fn op_id(&self) -> String {
        self.env.jj_text(&["--ignore-working-copy", "op", "log", "--no-graph", "--limit", "1", "-T", "id"])
    }

    /// History with something of everything the app renders: merges, conflicts, divergence, renames, binary files,
    /// non-ASCII paths and descriptions, and every kind of bookmark.
    fn rich() -> (Self, Ids) {
        let f = Self::empty();
        let lines = |tag: &str| (0..30).map(|n| format!("line {n} {tag}\n")).collect::<String>();
        let remote = f.dir.join("origin.git");
        let git = |args: &[&str]| {
            assert!(
                Command::new("git").args(args).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap().success()
            );
        };
        git(&["init", "--bare", "-b", "main", remote.to_str().unwrap()]);
        f.env.jj(&["git", "remote", "add", "origin", remote.to_str().unwrap()]);

        f.write("a.txt", lines("base"));
        f.write("README.md", "# Fixture\n");
        f.write("src/lib.rs", "fn main() {}\n");
        f.write("héllo/wörld ✓.txt", "grüße\n");
        f.write("blob.bin", [0u8, 159, 146, 150, 0, 255, 1, 2]);
        f.write("moved-from.txt", lines("moved"));
        let base = f.commit("base: äöü 日本語\n\nBody with\nseveral lines.");
        f.env.jj(&["bookmark", "create", "main", "-r", &base]);
        f.env.jj(&["bookmark", "create", "gone", "-r", &base]);
        f.env.jj(&["git", "push", "--bookmark", "main", "--bookmark", "gone"]);
        f.env.jj(&["bookmark", "delete", "gone"]);

        let mut edited = lines("base");
        edited = edited.replace("line 5 base", "line 5 feature");
        f.write("a.txt", edited);
        let feature = f.commit("feat: edit a");
        f.env.jj(&["bookmark", "create", "feature", "-r", &feature]);
        f.env.jj(&["git", "push", "--bookmark", "feature"]);

        f.write("blob.bin", [0u8, 1, 2, 3, 0, 255, 254]);
        fs::remove_file(f.env.root.join("moved-from.txt")).unwrap();
        f.write("moved-to.txt", lines("moved").replace("line 29 moved", "line 29 renamed"));
        f.write("héllo/wörld ✓.txt", "grüße, wörld\n");
        fs::remove_file(f.env.root.join("README.md")).unwrap();
        f.write("new file.md", "added\n");
        let mixed = f.commit("mixed: binary, rename, delete, add, non-ASCII");
        f.env.jj(&["bookmark", "set", "feature", "-r", &mixed]);
        let empty = f.commit("");

        f.env.jj(&["new", &base, "-m", "side"]);
        f.write("a.txt", lines("base").replace("line 5 base", "line 5 side"));
        f.env.jj(&["bookmark", "create", "local-only", "-r", "@"]);
        let side = f.id("@");

        f.env.jj(&["new", &feature, &side, "-m", "conflicted merge"]);
        let conflict = f.id("@");

        f.env.jj(&["new", &base, "-m", "clean side"]);
        f.write("src/lib.rs", "fn main() { println!(\"hi\"); }\n");
        let clean = f.id("@");
        f.env.jj(&["new", &clean, &mixed, "-m", "clean merge"]);
        let merge = f.id("@");

        f.env.jj(&["new", &base, "-m", "divergent"]);
        let change = f.env.jj_text(&["log", "--no-graph", "-r", "@", "-T", "change_id"]);
        let before = f.op_id();
        f.env.jj(&["describe", "-m", "divergent one"]);
        f.env.jj(&["--ignore-working-copy", &format!("--at-op={before}"), "describe", &change, "-m", "divergent two"]);
        // Any plain jj command now reconciles the operations, leaving the change divergent.
        f.env.jj(&["log", "-r", "root()"]);

        f.env.jj(&["bookmark", "create", "conflicted", "-r", &side]);
        let before = f.op_id();
        f.env.jj(&["bookmark", "set", "conflicted", "-r", &clean, "--allow-backwards"]);
        f.env.jj(&[
            "--ignore-working-copy",
            &format!("--at-op={before}"),
            "bookmark",
            "set",
            "conflicted",
            "-r",
            &mixed,
            "--allow-backwards",
        ]);
        f.env.jj(&["log", "-r", "root()"]);

        // On the remote but never tracked here.
        git(&["--git-dir", remote.to_str().unwrap(), "branch", "untracked", "main"]);
        f.env.jj(&["--config", r#"remotes.origin.auto-track-bookmarks="~*""#, "git", "fetch"]);

        f.env.jj(&["edit", &merge]);
        let ids = Ids { base, feature, mixed, empty, side, conflict, clean, merge };
        (f, ids)
    }

    fn repo_state(&self) -> RepoState {
        RepoState::read(&self.env.root)
    }
}

struct Ids {
    base: String,
    feature: String,
    mixed: String,
    empty: String,
    side: String,
    conflict: String,
    clean: String,
    merge: String,
}

/// Everything under `.jj` that a mutation would touch: path to (length, mtime).
#[derive(PartialEq, Eq, Debug)]
struct RepoState {
    op_heads: Vec<String>,
    entries: BTreeMap<PathBuf, (u64, std::time::SystemTime)>,
}

impl RepoState {
    fn read(root: &Path) -> Self {
        let repo = root.join(".jj/repo");
        let op_heads = fs::read_dir(repo.join("op_heads/heads"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap());
        let mut op_heads: Vec<_> = op_heads.collect();
        op_heads.sort();
        let mut entries = BTreeMap::new();
        for directory in [repo.join("op_heads"), repo.join("op_store"), root.join(".jj/working_copy")] {
            collect_files(&directory, &mut entries);
        }
        Self { op_heads, entries }
    }
}

fn collect_files(directory: &Path, entries: &mut BTreeMap<PathBuf, (u64, std::time::SystemTime)>) {
    for entry in fs::read_dir(directory).unwrap() {
        let entry = entry.unwrap();
        let metadata = entry.metadata().unwrap();
        if metadata.is_dir() {
            collect_files(&entry.path(), entries);
        } else {
            entries.insert(entry.path(), (metadata.len(), metadata.modified().unwrap()));
        }
    }
}

fn log_request(revset: &str, template: &str, graph: bool, limit: Option<u64>) -> Value {
    let mut request = json!({"kind": "log", "revset": revset, "template": template, "graph": graph});
    if let Some(limit) = limit {
        request["limit"] = json!(limit);
    }
    request
}

fn log_matrix(env: &JjEnv, helper: &mut Helper, revsets: &[&str]) {
    let log_template = log_template();
    for revset in revsets {
        for template in [REVISION_TEMPLATE, &log_template, BUILTIN_TEMPLATE] {
            for graph in [true, false] {
                assert_matches_cli(env, helper, log_request(revset, template, graph, None));
            }
        }
    }
}

#[test]
fn op_id_has_the_cli_bytes_and_no_newline() {
    let (f, _) = Fixture::rich();
    let mut helper = f.env.spawn();
    assert_matches_cli(&f.env, &mut helper, json!({"kind": "opId"}));
    let response = helper.request(json!({"kind": "opId"}));
    assert_eq!(response.payload.len(), 128);
    assert!(!response.payload.ends_with(b"\n"));
}

#[test]
fn log_covers_the_graph_shapes() {
    let (f, ids) = Fixture::rich();
    let mut helper = f.env.spawn();
    let skipping = format!("root() | {} | {} | {}", ids.base, ids.mixed, ids.merge);
    let missing_parent = format!("{}::", ids.feature);
    let merges_only = format!("{} | {}", ids.conflict, ids.merge);
    log_matrix(
        &f.env,
        &mut helper,
        &[
            "all()",
            "@",
            "::@",
            "immutable()",
            "mutable()",
            "trunk()",
            "trunk()..",
            "trunk()::",
            "bookmarks()",
            "remote_bookmarks()",
            "merges()",
            "conflicts()",
            "divergent()",
            "recent()",
            "described('feat')",
            "none()",
            "present(no-such-bookmark)",
            &skipping,
            &missing_parent,
            &merges_only,
        ],
    );
}

#[test]
fn log_limits_at_the_edges() {
    let (f, _) = Fixture::rich();
    let mut helper = f.env.spawn();
    let count =
        f.env.jj_text(&["--ignore-working-copy", "log", "--no-graph", "-r", "all()", "-T", r#""x""#]).len() as u64;
    for limit in [0, 1, 2, count - 1, count, count + 1, 100_000] {
        for graph in [true, false] {
            assert_matches_cli(&f.env, &mut helper, log_request("all()", REVISION_TEMPLATE, graph, Some(limit)));
        }
    }
}

#[test]
fn log_honours_config_that_changes_the_graph() {
    let (f, ids) = Fixture::rich();
    let skipping = format!("root() | {} | {}", ids.base, ids.merge);
    for config in [
        "ui.log-synthetic-elided-nodes=false",
        r#"ui.graph.style="ascii""#,
        r#"ui.graph.style="curved""#,
        r#"revsets.log-graph-prioritize="main""#,
        r#"templates.log_node="'N'""#,
        r#"revset-aliases."trunk()"="side-does-not-exist""#,
    ] {
        let mut env = f.env.clone();
        env.config.push(config.to_owned());
        let mut helper = env.spawn();
        for revset in [skipping.as_str(), "all()"] {
            for graph in [true, false] {
                assert_matches_cli(&env, &mut helper, log_request(revset, REVISION_TEMPLATE, graph, None));
            }
        }
    }
}

#[test]
fn log_templates_use_the_config_and_full_language() {
    let (f, _) = Fixture::rich();
    let mut helper = f.env.spawn();
    for template in [
        "shout(description)",
        "builtin_log_oneline",
        "builtin_log_detailed",
        "label('x', description) ++ commit_id.short(4) ++ \"\\n\"",
        "if(conflict, 'conflict\\n', '') ++ if(divergent, 'divergent\\n', '')",
        "change_id.shortest(8) ++ ' ' ++ commit_id.shortest() ++ \"\\n\"",
        "immutable ++ ' ' ++ empty ++ \"\\n\"",
    ] {
        for graph in [true, false] {
            assert_matches_cli(&f.env, &mut helper, log_request("all()", template, graph, None));
        }
    }
}

#[test]
fn diffs_cover_every_kind_of_change() {
    let (f, ids) = Fixture::rich();
    let mut helper = f.env.spawn();
    for commit in [&ids.base, &ids.feature, &ids.mixed, &ids.empty, &ids.side, &ids.conflict, &ids.clean, &ids.merge] {
        assert_matches_cli(&f.env, &mut helper, json!({"kind": "diff", "commitId": commit, "paths": []}));
        assert_matches_cli(
            &f.env,
            &mut helper,
            json!({"kind": "files", "commitId": commit, "template": FILES_TEMPLATE}),
        );
    }
    for paths in [
        json!(["a.txt"]),
        json!(["blob.bin"]),
        json!(["moved-to.txt"]),
        json!(["moved-from.txt"]),
        json!(["moved-to.txt", "moved-from.txt"]),
        json!(["héllo/wörld ✓.txt"]),
        json!(["héllo"]),
        json!(["glob:**/*.txt"]),
        json!(["root:src"]),
        json!(["does-not-exist.txt"]),
        json!(["~a.txt"]),
    ] {
        assert_matches_cli(&f.env, &mut helper, json!({"kind": "diff", "commitId": ids.mixed, "paths": paths}));
    }
}

#[test]
fn diff_output_has_the_cases_it_claims_to() {
    let (f, ids) = Fixture::rich();
    let mut helper = f.env.spawn();
    let diff = helper.request(json!({"kind": "diff", "commitId": ids.mixed, "paths": []})).payload;
    let diff = String::from_utf8_lossy(&diff);
    assert!(diff.contains("rename from moved-from.txt"), "{diff}");
    assert!(diff.contains("Binary files"), "{diff}");
    assert!(diff.contains("wörld"), "{diff}");
    let conflict = helper.request(log_request(&ids.conflict, "conflict ++ \"\\n\"", false, None)).payload;
    assert_eq!(conflict, b"true\n");
    let divergent = helper.request(log_request("divergent()", "'x'", false, None)).payload;
    assert!(divergent.len() >= 2, "the fixture has no divergent change");
}

#[test]
fn bookmarks_cover_every_state() {
    let (f, _) = Fixture::rich();
    let mut helper = f.env.spawn();
    assert_matches_cli(&f.env, &mut helper, json!({"kind": "bookmarks", "template": BOOKMARK_TEMPLATE}));
    assert_matches_cli(
        &f.env,
        &mut helper,
        json!({"kind": "bookmarks", "template": "name ++ '@' ++ remote ++ \"\\n\""}),
    );
    let listed =
        String::from_utf8(helper.request(json!({"kind": "bookmarks", "template": BOOKMARK_TEMPLATE})).payload).unwrap();
    for expected in [
        r#"["main","","#,
        r#"["main","git""#,
        r#"["main","origin""#,
        r#"["conflicted","""#,
        r#"["gone","""#,
        r#"["local-only","""#,
        r#"["untracked","origin""#,
    ] {
        assert!(listed.contains(expected), "{expected} missing from {listed}");
    }
    assert!(listed.contains(",true,false]\n"), "no conflicted bookmark in {listed}");
    assert!(listed.contains(",true,1,0]\n"), "no bookmark ahead of its remote in {listed}");
    assert!(listed.contains(r#"["untracked","origin",["#) && listed.contains(",false,false]\n"), "{listed}");
}

/// Every bookmark state from `Fixture::rich`: local, deleted with a remote, tracked ahead, untracked, Git-tracking, and
/// conflicted, whose added targets are more than one.
#[test]
fn helper_target_ids_print_what_added_targets_prints() {
    let (f, _) = Fixture::rich();
    let mut helper = f.env.spawn();
    for (fast, slow) in [
        (helper_bookmark_template(), BOOKMARK_TEMPLATE.to_owned()),
        (
            "name ++ '@' ++ remote ++ ' ' ++ json(jj_evolved_added_target_ids) ++ \"\\n\"".to_owned(),
            "name ++ '@' ++ remote ++ ' ' ++ json(added_targets.map(|c| c.commit_id())) ++ \"\\n\"".to_owned(),
        ),
        (
            "jj_evolved_added_target_ids.join(',') ++ ' ' ++ jj_evolved_added_target_ids.len() ++ \"\\n\"".to_owned(),
            "added_targets.map(|c| c.commit_id()).join(',') ++ ' ' ++ added_targets.len() ++ \"\\n\"".to_owned(),
        ),
    ] {
        assert_pair_matches_cli(
            &f.env,
            &mut helper,
            json!({"kind": "bookmarks", "template": fast}),
            json!({"kind": "bookmarks", "template": slow}),
        );
    }
    let listed = String::from_utf8(
        helper
            .request(json!({"kind": "bookmarks", "template": "json(jj_evolved_added_target_ids) ++ \"\\n\""}))
            .payload,
    )
    .unwrap();
    assert!(
        listed.lines().any(|line| line.matches(',').count() >= 1),
        "no conflicted bookmark with two targets: {listed}"
    );
    assert!(listed.lines().any(|line| line == "[]"), "no bookmark without targets: {listed}");

    // Plain jj doesn't have it, so the client must never send it to the CLI.
    let output = f
        .env
        .command(&["--ignore-working-copy", "bookmark", "list", "-T", "jj_evolved_added_target_ids"])
        .output()
        .unwrap();
    assert!(!output.status.success());
}

#[test]
fn bookmark_order_follows_config() {
    let (f, _) = Fixture::rich();
    let mut env = f.env.clone();
    env.config.push(r#"ui.bookmark-list-sort-keys=["name-"]"#.to_owned());
    let mut helper = env.spawn();
    assert_matches_cli(&env, &mut helper, json!({"kind": "bookmarks", "template": BOOKMARK_TEMPLATE}));
}

/// A local tag, one that moved away from its remote, one only on the remote, and a conflicted one.
fn tagged() -> (Fixture, PathBuf) {
    let (f, ids) = Fixture::rich();
    let remote = f.dir.join("origin.git");
    let git = |args: &[&str]| assert!(Command::new("git").args(args).stderr(Stdio::null()).status().unwrap().success());
    for (tag, commit) in [("v1.0", &ids.base), ("moved", &ids.base), ("remote-only", &ids.feature)] {
        git(&["--git-dir", remote.to_str().unwrap(), "tag", tag, commit]);
    }
    f.env.jj(&["git", "fetch", "--tag", "glob:*"]);
    f.env.jj(&["tag", "set", "moved", "-r", &ids.mixed, "--allow-move"]);
    f.env.jj(&["tag", "set", "local-ünï", "-r", &ids.side]);
    f.env.jj(&["tag", "set", "conflicted", "-r", &ids.side]);
    let before = f.op_id();
    f.env.jj(&["tag", "set", "conflicted", "-r", &ids.clean, "--allow-move"]);
    f.env.jj(&[
        "--ignore-working-copy",
        &format!("--at-op={before}"),
        "tag",
        "set",
        "conflicted",
        "-r",
        &ids.mixed,
        "--allow-move",
    ]);
    f.env.jj(&["log", "-r", "root()"]);
    (f, remote)
}

#[test]
fn tags_cover_every_state_and_follow_config() {
    let (f, _) = tagged();
    let mut helper = f.env.spawn();
    let all = "name ++ '@' ++ remote ++ ' ' ++ tracked ++ ' ' ++ conflict ++ ' ' ++ added_targets.map(|c| c.commit_id().short()) ++ \"\\n\"";
    // The last is jj's default `templates.tag_list`.
    for template in [TAG_TEMPLATE, all, r#"format_commit_ref(self, "tag") ++ "\n""#] {
        assert_matches_cli(&f.env, &mut helper, json!({"kind": "tags", "template": template}));
    }
    let listed = String::from_utf8(helper.request(json!({"kind": "tags", "template": all})).payload).unwrap();
    for expected in ["v1.0@ ", "moved@ ", "moved@origin ", "local-ünï@ ", "conflicted@ false true"] {
        assert!(listed.contains(expected), "{expected} missing from {listed}");
    }
    // Synced and untracked remote tags are left out, as `tag list` does without --all-remotes.
    assert!(!listed.contains("v1.0@origin"), "{listed}");

    let mut env = f.env.clone();
    env.config.push(r#"ui.tag-list-sort-keys=["name-"]"#.to_owned());
    let mut helper = env.spawn();
    assert_matches_cli(&env, &mut helper, json!({"kind": "tags", "template": TAG_TEMPLATE}));
}

/// The Git config that holds the remotes, wherever `jj git init` put the repository.
fn git_config(f: &Fixture) -> PathBuf {
    let colocated = f.env.root.join(".git");
    if colocated.exists() { colocated.join("config") } else { f.env.root.join(".jj/repo/store/git/config") }
}

#[test]
fn remotes_follow_git_config_that_changes_with_no_new_operation() {
    let (f, _) = Fixture::rich();
    let config = git_config(&f);
    let git_config = |args: &[&str]| {
        let status = Command::new("git").arg("config").arg("--file").arg(&config).args(args).status().unwrap();
        assert!(status.success(), "git config {args:?}");
    };
    let mut helper = f.env.spawn();
    let remotes = json!({"kind": "remotes"});
    assert_matches_cli(&f.env, &mut helper, remotes.clone());

    // `jj git remote add` records an operation, so the helper reloads for it anyway.
    f.env.jj(&["git", "remote", "add", "upstream", "https://example.com/upstream.git"]);
    assert_matches_cli(&f.env, &mut helper, remotes.clone());

    // The cases left in the CLI's output, as Git config edits under a running helper, which record no operation.
    let before = f.op_id();
    git_config(&["remote.split.url", "https://example.com/fetch.git"]);
    git_config(&["remote.split.pushurl", "ssh://example.com/push.git"]);
    git_config(&["remote.pushonly.pushurl", "ssh://example.com/only-push.git"]);
    git_config(&["remote.empty.tagopt", "--no-tags"]);
    git_config(&["remote.ünï.url", "https://example.com/ünï.git"]);
    assert_eq!(f.op_id(), before, "the test needs an edit that leaves the operation alone");
    assert_matches_cli(&f.env, &mut helper, remotes.clone());
    let listed = String::from_utf8(helper.request(remotes.clone()).payload).unwrap();
    for expected in [
        "upstream https://example.com/upstream.git\n",
        "split https://example.com/fetch.git (push: ssh://example.com/push.git)\n",
        "pushonly <no URL> (push: ssh://example.com/only-push.git)\n",
    ] {
        assert!(listed.contains(expected), "{expected} missing from {listed}");
    }
    assert!(!listed.contains("empty"), "{listed}");

    // Global Git config applies too, and is read again on each request.
    let home = PathBuf::from(&f.env.vars[0].1);
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join(".gitconfig"), "[url \"https://mirror.example.com/\"]\n\tinsteadOf = https://example.com/\n")
        .unwrap();
    assert_matches_cli(&f.env, &mut helper, remotes.clone());
    assert!(String::from_utf8(helper.request(remotes.clone()).payload).unwrap().contains("mirror.example.com"));

    git_config(&["--remove-section", "remote.split"]);
    assert_matches_cli(&f.env, &mut helper, remotes);
}

#[test]
fn invalid_requests_are_declined_and_the_process_keeps_going() {
    let (f, ids) = Fixture::rich();
    let mut helper = f.env.spawn();
    for request in [
        log_request("no_such_function()", REVISION_TEMPLATE, true, None),
        log_request("no-such-bookmark", REVISION_TEMPLATE, false, None),
        log_request("all()", "no_such_keyword", true, None),
        log_request("(", REVISION_TEMPLATE, true, None),
        json!({"kind": "diff", "commitId": "0123456789abcdef", "paths": []}),
        json!({"kind": "diff", "commitId": ids.base, "paths": ["bad:pattern"]}),
        json!({"kind": "files", "commitId": ids.base, "template": "no_such_keyword"}),
        json!({"kind": "bookmarks", "template": "no_such_keyword"}),
        json!({"kind": "log", "revset": "@", "template": "''"}),
        json!({"kind": "log", "revset": "@", "template": "''", "graph": true, "limit": -1}),
        json!({"kind": "nonsense"}),
    ] {
        helper.assert_declined(request);
    }
    for line in ["not json\n", "{\"kind\":\"opId\"}\n"] {
        helper.stdin.as_mut().unwrap().write_all(line.as_bytes()).unwrap();
        let header = helper.read_header().unwrap();
        assert_eq!(
            header,
            json!({"id": null, "ok": false, "error": "request is not a JSON object with an integer id", "len": 0})
        );
    }
    assert!(helper.request(json!({"kind": "opId"})).ok);
}

#[test]
fn op_must_be_the_head() {
    let (f, _) = Fixture::rich();
    let mut helper = f.env.spawn();
    let head = f.op_id();
    assert_matches_cli(
        &f.env,
        &mut helper,
        json!({"kind": "log", "op": head, "revset": "all()", "template": REVISION_TEMPLATE, "graph": false}),
    );
    assert_matches_cli(
        &f.env,
        &mut helper,
        json!({"kind": "log", "op": "@", "revset": "all()", "template": REVISION_TEMPLATE, "graph": true}),
    );
    let old = f.env.jj_text(&["--ignore-working-copy", "op", "log", "--no-graph", "-T", "id ++ \"\\n\""]);
    let old = old.lines().nth(3).unwrap();
    for op in [old, &head[..12], "@-", "not-an-op"] {
        for kind in ["opId", "log", "bookmarks"] {
            helper.assert_declined(json!({"kind": kind, "op": op, "revset": "@", "template": "''", "graph": false}));
        }
    }
}

#[test]
fn a_new_operation_shows_on_the_next_request() {
    let (f, _) = Fixture::rich();
    let mut helper = f.env.spawn();
    let at = || log_request("@", REVISION_TEMPLATE, false, None);
    assert_matches_cli(&f.env, &mut helper, at());
    let before = helper.request(at()).payload;
    let head_before = helper.request(json!({"kind": "opId"})).payload;

    f.env.jj(&["new", "-m", "created between requests"]);

    let after = helper.request(at()).payload;
    assert_ne!(before, after);
    assert!(String::from_utf8_lossy(&after).contains("created between requests"));
    assert_ne!(head_before, helper.request(json!({"kind": "opId"})).payload);
    assert_matches_cli(&f.env, &mut helper, at());
    assert_matches_cli(&f.env, &mut helper, json!({"kind": "opId"}));

    f.env.jj(&["bookmark", "create", "fresh", "-r", "@"]);
    assert_matches_cli(&f.env, &mut helper, json!({"kind": "bookmarks", "template": BOOKMARK_TEMPLATE}));
    f.env.jj(&["undo"]);
    assert_matches_cli(&f.env, &mut helper, json!({"kind": "bookmarks", "template": BOOKMARK_TEMPLATE}));
}

#[test]
fn divergent_op_heads_are_declined_and_left_alone() {
    let (f, ids) = Fixture::rich();
    let mut helper = f.env.spawn();
    assert!(helper.request(json!({"kind": "opId"})).ok);
    let before = f.op_id();
    f.env.jj(&["--ignore-working-copy", "describe", &ids.clean, "-m", "one side"]);
    f.env.jj(&["--ignore-working-copy", &format!("--at-op={before}"), "describe", &ids.clean, "-m", "other side"]);
    let state = f.repo_state();
    assert_eq!(state.op_heads.len(), 2);

    for request in [
        json!({"kind": "opId"}),
        log_request("all()", REVISION_TEMPLATE, true, None),
        json!({"kind": "diff", "commitId": ids.base, "paths": []}),
        json!({"kind": "files", "commitId": ids.base, "template": FILES_TEMPLATE}),
        json!({"kind": "bookmarks", "template": BOOKMARK_TEMPLATE}),
    ] {
        helper.assert_declined(request);
    }
    assert_eq!(state, f.repo_state(), "the helper touched divergent operations");

    // Once the CLI reconciles them, the helper serves again.
    f.env.jj(&["log", "-r", "root()"]);
    assert_eq!(f.repo_state().op_heads.len(), 1);
    assert_matches_cli(&f.env, &mut helper, log_request("all()", REVISION_TEMPLATE, true, None));
}

#[test]
fn starting_on_divergent_op_heads_serves_nothing_but_starts() {
    let (f, ids) = Fixture::rich();
    let before = f.op_id();
    f.env.jj(&["--ignore-working-copy", "describe", &ids.clean, "-m", "one side"]);
    f.env.jj(&["--ignore-working-copy", &format!("--at-op={before}"), "describe", &ids.clean, "-m", "other side"]);
    let state = f.repo_state();
    let mut helper = f.env.spawn();
    helper.assert_declined(log_request("all()", REVISION_TEMPLATE, true, None));
    assert_eq!(state, f.repo_state());
}

#[test]
fn a_session_writes_nothing() {
    let (f, ids) = Fixture::rich();
    // A pending working-copy edit: a snapshot would turn this into a new operation.
    f.write("uncommitted.txt", "not yet snapshotted\n");
    let state = f.repo_state();
    let mut helper = f.env.spawn();
    let log_template = log_template();
    for _ in 0..3 {
        for request in [
            json!({"kind": "opId"}),
            log_request("all()", &log_template, true, Some(50)),
            log_request("@", REVISION_TEMPLATE, false, None),
            json!({"kind": "diff", "commitId": ids.merge, "paths": []}),
            json!({"kind": "files", "commitId": ids.merge, "template": FILES_TEMPLATE}),
            json!({"kind": "bookmarks", "template": BOOKMARK_TEMPLATE}),
            log_request("no_such_function()", "''", true, None),
        ] {
            helper.request(request);
        }
    }
    assert_eq!(helper.close_and_wait(), 0);
    assert_eq!(state, f.repo_state());
}

#[test]
fn exits_cleanly_on_eof_and_on_a_broken_pipe() {
    let (f, _) = Fixture::rich();
    assert_eq!(f.env.spawn().close_and_wait(), 0);

    let Helper { mut child, stdin, stdout, .. } = f.env.spawn();
    drop(stdout);
    let mut stdin = stdin.unwrap();
    let _ = stdin.write_all(b"{\"id\":1,\"kind\":\"opId\"}\n");
    let _ = stdin.flush();
    assert_eq!(child.wait().unwrap().code(), Some(0));
}

fn assert_exits_for_config_change(helper: &mut Helper) {
    helper.send(json!({"kind": "opId"}));
    assert!(helper.read_header().is_none(), "answered a request on stale config");
    assert_eq!(helper.child.wait().unwrap().code(), Some(75));
}

#[test]
fn config_changes_exit_with_75() {
    let f = Fixture::empty();
    let user_config = PathBuf::from(&f.env.vars[2].1);
    let original = fs::read_to_string(&user_config).unwrap();

    let mut helper = f.env.spawn();
    assert!(helper.request(json!({"kind": "opId"})).ok);
    fs::write(&user_config, format!("{original}\n[ui]\ngraph.style = \"ascii\"\n")).unwrap();
    assert_exits_for_config_change(&mut helper);

    // Repo and workspace config: neither file exists until these commands create it.
    let mut helper = f.env.spawn();
    f.env.jj(&["config", "set", "--repo", "ui.graph.style", "curved"]);
    assert_exits_for_config_change(&mut helper);

    let mut helper = f.env.spawn();
    f.env.jj(&["config", "set", "--repo", "ui.graph.style", "square"]);
    assert_exits_for_config_change(&mut helper);

    let mut helper = f.env.spawn();
    f.env.jj(&["config", "set", "--workspace", "ui.graph.style", "ascii"]);
    assert_exits_for_config_change(&mut helper);
}

#[test]
fn config_paths_that_do_not_exist_yet_are_watched() {
    let f = Fixture::empty();
    let mut env = f.env.clone();
    env.vars.retain(|(name, _)| name != "JJ_CONFIG");
    let home = PathBuf::from(&env.vars[0].1);
    let xdg = PathBuf::from(&env.vars[1].1);
    fs::create_dir_all(&home).unwrap();
    let name_user = "[user]\nname = \"N\"\nemail = \"e@example.com\"\n";

    let mut helper = env.spawn();
    fs::create_dir_all(xdg.join("jj")).unwrap();
    fs::write(xdg.join("jj/config.toml"), name_user).unwrap();
    assert_exits_for_config_change(&mut helper);

    let mut helper = env.spawn();
    fs::write(home.join(".jjconfig.toml"), name_user).unwrap();
    assert_exits_for_config_change(&mut helper);

    let mut helper = env.spawn();
    fs::create_dir_all(xdg.join("jj/conf.d")).unwrap();
    fs::write(xdg.join("jj/conf.d/extra.toml"), "").unwrap();
    assert_exits_for_config_change(&mut helper);

    let mut helper = env.spawn();
    fs::write(xdg.join("jj/conf.d/extra.toml"), "[ui]\ngraph.style = \"ascii\"\n").unwrap();
    assert_exits_for_config_change(&mut helper);
}

#[test]
fn refuses_what_it_cannot_serve_faithfully() {
    let f = Fixture::empty();
    let launch = |args: &[&str]| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_jj-evolved-helper"));
        command
            .current_dir(&f.env.root)
            .args(args)
            .envs(f.env.vars.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        let output = command.output().unwrap();
        let line = String::from_utf8(output.stdout).unwrap();
        (output.status.code(), line.lines().next().map(|line| serde_json::from_str::<Value>(line).unwrap()))
    };
    for args in [
        vec!["--at-op=@", "--config", "ui.log-word-wrap=false", "serve"],
        vec!["--ignore-working-copy", "--config", "ui.log-word-wrap=false", "serve"],
        vec!["--ignore-working-copy", "--at-op=@", "--config", "ui.log-word-wrap=true", "serve"],
        vec!["--repository", "/nonexistent", "--ignore-working-copy", "--at-op=@", "serve"],
        vec!["--ignore-working-copy", "new"],
    ] {
        let (code, header) = launch(&args);
        assert_ne!(code, Some(0), "{args:?}");
        let header = header.expect("needs a failure header");
        assert_eq!(header["ready"], false, "{args:?}");
        assert!(header["error"].is_string());
        assert_eq!(header["len"], 0);
    }

    fs::OpenOptions::new()
        .append(true)
        .open(&f.env.vars[2].1)
        .unwrap()
        .write_all(b"\n[[--scope]]\n--when.commands = [\"log\"]\n[--scope.ui]\ngraph.style = \"ascii\"\n")
        .unwrap();
    let (_, header) = launch(&["--ignore-working-copy", "--at-op=@", "--config", "ui.log-word-wrap=false", "serve"]);
    assert_eq!(header.unwrap()["ready"], false);
}

#[test]
fn secondary_workspace_sees_its_own_working_copy() {
    let (f, _) = Fixture::rich();
    let second = f.dir.join("second");
    f.env.jj(&["workspace", "add", second.to_str().unwrap(), "--name", "second"]);
    let mut env = f.env.clone();
    env.root = second;
    let mut helper = env.spawn();
    assert_matches_cli(&env, &mut helper, log_request("all()", REVISION_TEMPLATE, true, None));
    assert_matches_cli(&env, &mut helper, log_request("@", REVISION_TEMPLATE, false, None));
}

/// Read-only differential over the benchmark repositories. `--ignore-working-copy` is on every command on both sides.
#[test]
fn bench_repos() {
    let Ok(bench) = std::env::var("JJ_EVOLVED_BENCH_ROOT") else {
        eprintln!("skipped: JJ_EVOLVED_BENCH_ROOT is not set");
        return;
    };
    let bench = PathBuf::from(bench);
    let repos = std::env::var("JJ_EVOLVED_BENCH_REPOS").unwrap_or_else(|_| "jj,git,rust".to_owned());
    for name in repos.split(',') {
        let env = JjEnv {
            root: bench.join("repos").join(name),
            vars: vec![
                ("JJ_CONFIG".to_owned(), bench.join("jj-config.toml").display().to_string()),
                // Also keeps jj's per-repo secure config out of the real home directory.
                ("XDG_CONFIG_HOME".to_owned(), bench.join("xdg").display().to_string()),
            ],
            config: vec![],
        };
        let state = RepoState::read(&env.root);
        let mut helper = env.spawn();
        let log_template = log_template();
        let mut requests = vec![
            json!({"kind": "opId"}),
            json!({"kind": "bookmarks", "template": BOOKMARK_TEMPLATE}),
            json!({"kind": "tags", "template": TAG_TEMPLATE}),
            json!({"kind": "remotes"}),
        ];
        for (revset, limit) in [
            ("all()", 300),
            ("::trunk()", 2000),
            ("present(@) | ancestors(trunk(), 200)", 1000),
            ("trunk() | merges()", 300),
            ("::trunk() ~ merges()", 300),
            ("bookmarks()", 300),
            ("immutable()", 100),
            ("heads(all())", 300),
            ("none()", 300),
        ] {
            for graph in [true, false] {
                requests.push(log_request(revset, &log_template, graph, Some(limit)));
            }
        }
        requests.push(log_request("ancestors(trunk(), 3000)", REVISION_TEMPLATE, true, None));
        requests.push(log_request("ancestors(trunk(), 3000)", REVISION_TEMPLATE, false, None));

        let commits = env.jj_text(&[
            "--ignore-working-copy",
            "--at-op=@",
            "log",
            "--no-graph",
            "--limit",
            "150",
            "-r",
            "ancestors(trunk(), 40)",
            "-T",
            "commit_id ++ \"\\n\"",
        ]);
        let mut files_checked = 0;
        for commit in commits.lines() {
            requests.push(json!({"kind": "diff", "commitId": commit, "paths": []}));
            requests.push(json!({"kind": "files", "commitId": commit, "template": FILES_TEMPLATE}));
            let changed = env.jj_text(&["--ignore-working-copy", "diff", "-r", commit, "-T", "path ++ \"\\n\""]);
            if let Some(path) = changed.lines().next() {
                files_checked += 1;
                let quoted = serde_json::to_string(path).unwrap();
                requests.push(json!({"kind": "diff", "commitId": commit, "paths": [format!("root-file:{quoted}")]}));
                requests.push(json!({"kind": "diff", "commitId": commit, "paths": ["glob:**/*.md"]}));
            }
        }
        assert!(files_checked > 0);
        let started = std::time::Instant::now();
        assert_pair_matches_cli(
            &env,
            &mut helper,
            json!({"kind": "bookmarks", "template": helper_bookmark_template()}),
            json!({"kind": "bookmarks", "template": BOOKMARK_TEMPLATE}),
        );
        eprintln!("{name}: bookmarks with jj_evolved_added_target_ids: {:?}", started.elapsed());

        let total = requests.len();
        let started = std::time::Instant::now();
        for request in requests {
            let one = std::time::Instant::now();
            let label = format!("{} {} {}", request["kind"], request["revset"], request["limit"]);
            assert_matches_cli(&env, &mut helper, request);
            eprintln!("{name}: {label}: {:?}", one.elapsed());
        }
        eprintln!("{name}: {total} requests matched in {:?}", started.elapsed());
        assert_eq!(helper.close_and_wait(), 0);
        assert_eq!(state, RepoState::read(&env.root), "{name} was modified");
    }
}
