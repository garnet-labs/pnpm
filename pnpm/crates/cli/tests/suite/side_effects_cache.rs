#![cfg(unix)]

use crate::_utils::pacquet_in;
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

/// A build whose whole effect lands outside the package directory — a
/// git-hook installer, a script seeding a shared download cache — has
/// nothing for the side-effects cache to record. The cache still gets a row
/// for it, because a row is written whenever a script ran, but restoring
/// that row materializes nothing. Taking it as a cache hit would skip the
/// scripts and put nothing in their place, so the effect never happens at
/// all. pnpm 11 rebuilds here and so must pacquet.
///
/// Regression for <https://github.com/pnpm/pnpm/issues/14717>.
#[test]
fn a_build_with_nothing_to_restore_runs_on_every_install() {
    let CommandTempCwd { pacquet, root, workspace, npmrc_info, .. } =
        CommandTempCwd::init().add_mocked_registry();
    let AddMockedRegistry { mock_instance, .. } = npmrc_info;

    let yaml_path = workspace.join("pnpm-workspace.yaml");
    let mut yaml = fs::read_to_string(&yaml_path).expect("read pnpm-workspace.yaml");
    if !yaml.ends_with('\n') {
        yaml.push('\n');
    }
    yaml.push_str("allowBuilds:\n  '@pnpm.e2e/postinstall-writes-outside-package': true\n");
    fs::write(&yaml_path, yaml).expect("write pnpm-workspace.yaml");

    fs::write(
        workspace.join("package.json"),
        serde_json::json!({
            "dependencies": { "@pnpm.e2e/postinstall-writes-outside-package": "1.0.0" },
        })
        .to_string(),
    )
    .expect("write package.json");

    // The package's postinstall appends one byte here, so the file's length
    // is the number of installs that actually ran it. It lives outside the
    // workspace, which is the whole point: nothing the script does is
    // inside the package, so the recorded diff is empty.
    let log = root.path().join("outside-log");
    fs::write(&log, "").expect("create the log");
    let runs = || fs::read_to_string(&log).expect("read the log").len();

    pacquet
        .with_arg("install")
        .with_env("PNPM_E2E_OUTSIDE_LOG", log.to_string_lossy().as_ref())
        .assert()
        .success();
    assert_eq!(runs(), 1, "the first install runs the postinstall");

    for install in 2..=3 {
        fs::remove_dir_all(workspace.join("node_modules")).expect("remove node_modules");
        let output = Command::cargo_bin("pnpm")
            .expect("find the pnpm binary")
            .with_current_dir(&workspace)
            .with_args(["install", "--frozen-lockfile"])
            .with_env("PNPM_E2E_OUTSIDE_LOG", log.to_string_lossy().as_ref())
            .output()
            .expect("run the install");
        assert!(output.status.success(), "install must succeed: {output:?}");
        assert_eq!(
            runs(),
            install,
            "install {install} must run the postinstall again, since the cache has nothing to \
             restore in its place:\n{}",
            String::from_utf8_lossy(&output.stdout),
        );
    }

    drop((root, mock_instance));
}

// A git hook is written into the consuming project's `.git/hooks`
// (`simple-git-hooks`, `husky`), so the cache records nothing for the build
// that installs it. A second project on the same store must still get its
// hook from a plain install, with the cache left on.
// <https://github.com/pnpm/pnpm/issues/14717>
#[test]
fn a_second_project_on_the_store_gets_the_hook_from_a_default_install() {
    let SecondProject { root, mock_instance, hook, default_install, .. } =
        SecondProject::after_a_cached_install();

    assert!(
        default_install.contains("git-hook-installer postinstall$"),
        "the second project must run the script the empty cache row cannot restore:\n\
         {default_install}",
    );
    assert_hook_installed(&hook);

    drop((root, mock_instance));
}

// `sideEffectsCache: false` keeps running the script for a project that
// turns the cache off entirely.
#[test]
fn a_second_project_on_the_store_gets_the_hook_without_the_cache() {
    let SecondProject { root, mock_instance, project, hook, .. } =
        SecondProject::after_a_cached_install();

    eprintln!("Second project with `sideEffectsCache: false`: the script runs again...");
    let yaml_path = project.join("pnpm-workspace.yaml");
    let mut yaml = fs::read_to_string(&yaml_path).expect("read the second pnpm-workspace.yaml");
    yaml.push_str("sideEffectsCache: false\n");
    fs::write(&yaml_path, yaml).expect("write the second pnpm-workspace.yaml");
    fs::remove_dir_all(project.join("node_modules")).expect("remove the second node_modules");

    let rebuilt = pacquet_output(&project, &["install"]);
    assert!(
        rebuilt.contains("git-hook-installer postinstall$"),
        "with the cache off the second project must run the script:\n{rebuilt}",
    );
    assert_hook_installed(&hook);

    drop((root, mock_instance));
}

// `pnpm rebuild` runs the scripts regardless of the cache, so it is the
// other documented way for the second project to get its hook.
#[test]
fn a_second_project_on_the_store_gets_the_hook_after_an_explicit_rebuild() {
    let SecondProject { root, mock_instance, project, hook, .. } =
        SecondProject::after_a_cached_install();

    eprintln!("Second project: `pnpm rebuild` runs the script again...");
    let rebuilt = pacquet_output(&project, &["rebuild"]);
    assert!(
        rebuilt.contains("git-hook-installer postinstall$"),
        "rebuild must run the script:\n{rebuilt}",
    );
    assert_hook_installed(&hook);

    drop((root, mock_instance));
}

// A second project that just installed `@pnpm.e2e/git-hook-installer`
// against a store another project already seeded, with the side-effects
// cache left at its default.
struct SecondProject {
    root: TempDir,
    mock_instance: TestRegistry,
    project: PathBuf,
    hook: PathBuf,
    default_install: String,
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

        eprintln!("Second project (warm store, cache at its default)...");
        let default_install = pacquet_output(&project, &["install"]);

        SecondProject { root, mock_instance, project, hook, default_install }
    }
}

fn assert_hook_installed(hook: &Path) {
    let content = fs::read_to_string(hook).expect("read the pre-commit hook the script installs");
    assert!(
        content.contains("installed by @pnpm.e2e/git-hook-installer"),
        "unexpected pre-commit hook content:\n{content}",
    );
}

fn pacquet_output(project: &Path, args: &[&str]) -> String {
    let output = pacquet_in(project).with_args(args).output().expect("run pacquet");
    assert!(output.status.success(), "pacquet must succeed: {output:?}");
    let mut reported = String::from_utf8_lossy(&output.stdout).into_owned();
    reported.push_str(&String::from_utf8_lossy(&output.stderr));
    reported
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
