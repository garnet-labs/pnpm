#![cfg(unix)]

use assert_cmd::prelude::*;
use command_extra::CommandExtra;
use pnpm_testing_utils::{
    bin::{AddMockedRegistry, CommandTempCwd},
    registry::TestRegistry,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;

/// Regression for <https://github.com/pnpm/pnpm/issues/12042#issuecomment-4682732058>:
/// a package approved via `allowBuilds` whose lifecycle script produces
/// files not in its tarball (e.g. `bun`'s postinstall downloading a
/// binary) loses that output on a warm frozen reinstall.
///
/// `sideEffectsCache` is on by default, so the first build seeds the
/// cache. On the second frozen install the `is_built` gate skips the
/// rebuild — the cached build output must still be materialized into the
/// freshly linked slot, mirroring pnpm's `getFlatMap` applying the
/// side-effects diff at import time. Without that, the slot is left with
/// only the pristine tarball files and the package is broken at runtime.
#[test]
fn side_effects_materialized_on_warm_frozen_reinstall() {
    assert_side_effects_materialized(false);
}

/// TS: `using side effects cache with nodeLinker=hoisted`
/// (`deps-restorer/test/index.ts:706`).
#[test]
fn side_effects_materialized_on_warm_frozen_reinstall_with_hoisted_linker() {
    assert_side_effects_materialized(true);
}

fn assert_side_effects_materialized(hoisted: bool) {
    let CommandTempCwd { pacquet, root, workspace, npmrc_info, .. } =
        CommandTempCwd::init().add_mocked_registry();
    let AddMockedRegistry { mock_instance, .. } = npmrc_info;

    // `allowBuilds` in `pnpm-workspace.yaml`, exactly like the report.
    let yaml_path = workspace.join("pnpm-workspace.yaml");
    let mut yaml = fs::read_to_string(&yaml_path).expect("read pnpm-workspace.yaml");
    if !yaml.ends_with('\n') {
        yaml.push('\n');
    }
    yaml.push_str("allowBuilds:\n  '@pnpm.e2e/pre-and-postinstall-scripts-example': true\n");
    if hoisted {
        yaml.push_str("nodeLinker: hoisted\n");
    }
    fs::write(&yaml_path, yaml).expect("write pnpm-workspace.yaml");

    let manifest_path = workspace.join("package.json");
    let package_json = serde_json::json!({
        "dependencies": {
            "@pnpm.e2e/pre-and-postinstall-scripts-example": "1.0.0",
        },
    });
    fs::write(&manifest_path, package_json.to_string()).expect("write package.json");

    // `generated-by-postinstall.js` is written by the package's
    // postinstall and is not part of its tarball, so it only exists if
    // the build ran or its cached output was materialized.
    let postinstall_artifact = if hoisted {
        workspace.join(
            "node_modules/@pnpm.e2e/pre-and-postinstall-scripts-example/generated-by-postinstall.js",
        )
    } else {
        workspace.join(
            "node_modules/.pnpm/@pnpm.e2e+pre-and-postinstall-scripts-example@1.0.0\
             /node_modules/@pnpm.e2e/pre-and-postinstall-scripts-example/generated-by-postinstall.js",
        )
    };

    eprintln!("First install (non-frozen, writes lockfile + populates store)...");
    pacquet.with_arg("install").assert().success();

    eprintln!("Wiping node_modules before the first frozen install...");
    fs::remove_dir_all(workspace.join("node_modules")).expect("remove node_modules");

    eprintln!("Frozen install (builds, writes the side-effects cache)...");
    run_frozen_install(&workspace);
    assert!(postinstall_artifact.exists(), "postinstall must run on the first frozen install");

    eprintln!("Wiping node_modules (keep store + lockfile, like a fresh CI checkout)...");
    fs::remove_dir_all(workspace.join("node_modules")).expect("remove node_modules");

    eprintln!("Frozen reinstall (warm store, hits the is_built gate)...");
    run_frozen_install(&workspace);
    assert!(
        postinstall_artifact.exists(),
        "the cached postinstall output must be materialized after a warm frozen reinstall",
    );

    drop((root, mock_instance));
}

/// The cache records what a build writes inside its own package directory
/// and nothing else. A script that writes into the consuming project, such
/// as a git hook under `.git/hooks` the way `simple-git-hooks` and `husky`
/// install theirs, leaves nothing for the cache to restore. The first
/// project on a store runs the script and gets its hook. A second project
/// on the same store gets the cached build instead, and no hook. That is
/// the intended trade, and `sideEffectsCache: false` is the documented way
/// for such a project to opt out of it.
///
/// Pins both halves: the second project does not run the script on a warm
/// store, and the same project with `sideEffectsCache: false` does.
/// Regression for <https://github.com/pnpm/pnpm/issues/14717>.
#[test]
fn a_second_project_on_the_store_gets_the_hook_only_without_the_cache() {
    let SecondProject { root, mock_instance, project, hook } =
        SecondProject::after_a_cached_install();

    eprintln!("Second project with `sideEffectsCache: false`: the script runs again...");
    let yaml_path = project.join("pnpm-workspace.yaml");
    let mut yaml = fs::read_to_string(&yaml_path).expect("read the second pnpm-workspace.yaml");
    yaml.push_str("sideEffectsCache: false\n");
    fs::write(&yaml_path, yaml).expect("write the second pnpm-workspace.yaml");
    fs::remove_dir_all(project.join("node_modules")).expect("remove the second node_modules");

    let rebuilt = pacquet_stdout(&project, &["install"]);
    assert!(
        rebuilt.contains("git-hook-installer postinstall$"),
        "with the cache off the second project must run the script:\n{rebuilt}",
    );
    assert_hook_installed(&hook);

    drop((root, mock_instance));
}

/// `pnpm rebuild` runs the scripts regardless of the cache, so it is the
/// other documented way for the second project to get its hook.
#[test]
fn a_second_project_on_the_store_gets_the_hook_after_an_explicit_rebuild() {
    let SecondProject { root, mock_instance, project, hook } =
        SecondProject::after_a_cached_install();

    eprintln!("Second project: `pnpm rebuild` runs the script the cache answered for...");
    let rebuilt = pacquet_stdout(&project, &["rebuild"]);
    assert!(
        rebuilt.contains("git-hook-installer postinstall$"),
        "rebuild must run the script:\n{rebuilt}",
    );
    assert_hook_installed(&hook);

    drop((root, mock_instance));
}

/// A second project that just installed `@pnpm.e2e/git-hook-installer`
/// against a store another project already seeded: the build came from the
/// side-effects cache, the script did not run, and `hook` does not exist.
struct SecondProject {
    root: TempDir,
    mock_instance: TestRegistry,
    project: PathBuf,
    hook: PathBuf,
}

impl SecondProject {
    fn after_a_cached_install() -> Self {
        let CommandTempCwd { pacquet, root, workspace, npmrc_info, .. } =
            CommandTempCwd::init().add_mocked_registry();
        let AddMockedRegistry { mock_instance, .. } = npmrc_info;

        let yaml_path = workspace.join("pnpm-workspace.yaml");
        let mut yaml = fs::read_to_string(&yaml_path).expect("read pnpm-workspace.yaml");
        if !yaml.ends_with('\n') {
            yaml.push('\n');
        }
        yaml.push_str("allowBuilds:\n  '@pnpm.e2e/git-hook-installer': true\n");
        fs::write(&yaml_path, yaml).expect("write pnpm-workspace.yaml");

        let package_json = serde_json::json!({
            "dependencies": { "@pnpm.e2e/git-hook-installer": "1.0.0" },
        })
        .to_string();
        fs::write(workspace.join("package.json"), &package_json).expect("write package.json");
        fs::create_dir(workspace.join(".git")).expect("create .git in the first project");

        eprintln!("First project (cold store): the script runs and installs the hook...");
        pacquet.with_arg("install").assert().success();
        assert_hook_installed(&workspace.join(".git/hooks/pre-commit"));

        // The second project shares the store and the registry through the
        // same relative `../pacquet-store` config the first one uses.
        let project = root.path().join("project-b");
        fs::create_dir(&project).expect("create the second project");
        for file in [".npmrc", "pnpm-workspace.yaml"] {
            fs::copy(workspace.join(file), project.join(file))
                .expect("copy config to the second project");
        }
        fs::write(project.join("package.json"), &package_json)
            .expect("write the second package.json");
        fs::create_dir(project.join(".git")).expect("create .git in the second project");
        let hook = project.join(".git/hooks/pre-commit");

        eprintln!("Second project (warm store): the cache answers for the build...");
        let cached = pacquet_stdout(&project, &["install"]);
        assert!(
            !cached.contains("git-hook-installer postinstall$"),
            "the second project must get the cached build rather than run the script:\n{cached}",
        );
        assert!(
            !hook.exists(),
            "a hook the cache cannot restore must be missing after a cached build"
        );

        SecondProject { root, mock_instance, project, hook }
    }
}

fn assert_hook_installed(hook: &Path) {
    let content = fs::read_to_string(hook).expect("read the pre-commit hook the script installs");
    assert!(
        content.contains("installed by @pnpm.e2e/git-hook-installer"),
        "unexpected pre-commit hook content:\n{content}",
    );
}

/// A fresh `pacquet <args>` in `project` that must succeed, returning what
/// it printed. The registry config lives in the project's `.npmrc` /
/// `pnpm-workspace.yaml` and the mock registry is a process-global
/// singleton kept alive by the caller, so this only needs its own command.
fn pacquet_stdout(project: &Path, args: &[&str]) -> String {
    let output = Command::cargo_bin("pnpm")
        .expect("find the pnpm binary")
        .with_current_dir(project)
        .with_args(args)
        .output()
        .expect("run pacquet");
    assert!(output.status.success(), "pacquet must succeed: {output:?}");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// A fresh `pacquet install --frozen-lockfile` against an existing
/// workspace. The registry config lives in the workspace's `.npmrc` /
/// `pnpm-workspace.yaml` and the mock registry is a process-global
/// singleton kept alive by the caller, so this only needs its own
/// command — no extra `CommandTempCwd` / registry.
fn run_frozen_install(workspace: &Path) {
    Command::cargo_bin("pnpm")
        .expect("find the pnpm binary")
        .with_current_dir(workspace)
        .with_args(["install", "--frozen-lockfile"])
        .assert()
        .success();
}
