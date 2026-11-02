//! Detects changes to any config file the helper read, or could have read.
//!
//! Config is resolved once, by `CliRunner`, before `serve` starts. When a file changes, the only faithful option is to
//! start over, so the helper exits and the client respawns it.

use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::time::SystemTime;

use jj_cli::cli_util::CommandHelper;
use jj_cli::command_error::CommandError;

type Stamp = Option<(SystemTime, u64, u64)>;

fn stamp(path: &Path) -> Stamp {
    use std::os::unix::fs::MetadataExt as _;
    let metadata = fs::metadata(path).ok()?;
    Some((metadata.modified().ok()?, metadata.len(), metadata.ino()))
}

pub struct ConfigWatch {
    files: Vec<(PathBuf, Stamp)>,
}

impl ConfigWatch {
    pub fn new(command: &CommandHelper) -> Result<Self, CommandError> {
        let mut paths = candidate_paths(command)?;
        // A directory's mtime covers files appearing and leaving; each file's own stamp covers edits.
        for directory in paths.clone() {
            if let Ok(entries) = fs::read_dir(&directory) {
                paths.extend(entries.flatten().map(|entry| entry.path()));
            }
        }
        paths.sort();
        paths.dedup();
        Ok(Self {
            files: paths
                .into_iter()
                .map(|path| {
                    let recorded = stamp(&path);
                    (path, recorded)
                })
                .collect(),
        })
    }

    pub fn changed(&self) -> bool {
        self.files.iter().any(|(path, recorded)| stamp(path) != *recorded)
    }
}

/// Every path that could contribute a config layer. `ConfigEnv` only lists the ones that exist, and its accessors that
/// would name the repo and workspace paths create them, so the paths that don't exist yet are rebuilt here from
/// `ConfigEnv::from_environment` and `SecureConfig`.
fn candidate_paths(command: &CommandHelper) -> Result<Vec<PathBuf>, CommandError> {
    let env = command.config_env();
    let mut paths: Vec<PathBuf> = env.user_config_paths().map(Path::to_owned).collect();
    paths.extend(env.existing_system_config_paths().map(Path::to_owned));
    let raw_config = command.raw_config().as_ref();
    paths.extend(raw_config.layers().iter().filter_map(|layer| layer.path.clone()));

    let root_config_dir = env.repo_configs_root_dir().and_then(|dir| dir.parent().map(Path::to_owned));
    if std::env::var_os("JJ_CONFIG").is_none() {
        paths.push("/etc/jj/config.toml".into());
        paths.push("/etc/jj/conf.d".into());
        paths.extend(std::env::home_dir().map(|home| home.join(".jjconfig.toml")));
        if let Some(dir) = &root_config_dir {
            paths.push(dir.join("config.toml"));
            paths.push(dir.join("conf.d"));
        }
    }

    let loader = command.workspace_loader()?;
    let secure_configs = [
        (loader.repo_path().to_owned(), "config-id", "config.toml", "repos"),
        (loader.workspace_root().join(".jj"), "workspace-config-id", "workspace-config.toml", "workspaces"),
    ];
    for (directory, id_file, legacy_file, config_kind) in secure_configs {
        let id_path = directory.join(id_file);
        if let (Ok(id), Some(root)) = (fs::read_to_string(&id_path), &root_config_dir) {
            paths.push(root.join(config_kind).join(id.trim()).join("config.toml"));
        }
        paths.push(id_path);
        paths.push(directory.join(legacy_file));
    }
    Ok(paths)
}
