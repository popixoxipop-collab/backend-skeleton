#!/usr/bin/env python3
"""Replay the historical T03 package seam on a disposable consumer without writing GitHub."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
from urllib.request import Request, urlopen


REMOTE = "https://github.com/popixoxipop-collab/backend-skeleton.git"
PREVIOUS = "271d5d747d7ef99fb7ce990a95db32fbdf4e46bd"
PREVIOUS_TREE = "c5f1da277f3858cc93cefa8b6c3c0d5956b23e07"
HISTORICAL_PACKAGE_COMMIT = "f43c6e78279ec0921e5608359f1696946aef0fda"
HISTORICAL_PACKAGE_TREE = "bd187ad9a6cb7d93f367d59ee5ee1495e6547184"
HISTORICAL_PACKAGE_SHA = "598fb1cbcfd4d0e2e8842b2c120efeac2b76112a25e589b1f14450deea00dc5a"
# XOX independently confirmed this reproducible archive has the original package inventory.
REPRODUCED_HISTORICAL_PACKAGE_SHA = "caa66cfd979341fa63e441af3d38184ef52a5e6d73b4749afeb1ebcaefbe5742"
MODULE = "scanners/capability-next/index.mjs"

PROBE = r"""
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = await realpath('node_modules/backend-skeleton');
const entry = await realpath(path.join(root, 'scanners/capability-next/index.mjs'));
assert.equal(entry, path.join(root, 'scanners/capability-next/index.mjs'));
const api = await import(pathToFileURL(entry));
const requirements = [{capability: 'legacyRoute'}];
const supported = api.evaluateCapabilityPolicy({
  capabilities: api.fromLegacyCapabilities({legacyRoute: true}), requirements,
});
assert.equal(supported.allowed, true);
assert.equal(supported.decisions[0].status, 'supported');
const unknown = api.capabilityRecord({name: 'legacyRoute', status: 'unknown', reason: 'no target evidence'});
const blocked = api.evaluateCapabilityPolicy({capabilities: {legacyRoute: unknown}, requirements});
assert.equal(blocked.allowed, false);
assert.equal(blocked.decisions[0].status, 'unknown');
assert.throws(() => api.certificationRecord({targetId: 'probe', level: 'runtime-tested'}), TypeError);
assert.deepEqual(api.buildSupportMatrix(), []);
console.log(JSON.stringify({legacy_policy: 'supported', unknown_policy: 'rejected', runtime_certification: 'rejected'}));
if (process.argv.includes('hold')) setInterval(() => {}, 1000);
"""


def require(condition, detail):
    if not condition:
        raise ValueError(detail)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(argv, directory, env, timeout=50):
    process = subprocess.run(argv, cwd=directory, env=env, capture_output=True, timeout=timeout)
    require(process.returncode == 0, f"{Path(argv[0]).name} failed (exit {process.returncode})")
    return process.stdout


def archive_inventory(archive, git_tree):
    git_files = {entry.split(b"\t", 1)[1].decode(): entry.split(b"\t", 1)[0].split()
                 for entry in git_tree.split(b"\0") if entry}
    files = {}
    with tarfile.open(archive, "r:gz") as package:
        for item in package:
            parts = PurePosixPath(item.name).parts
            require(item.isfile() and len(parts) > 1 and parts[0] == "package" and ".." not in parts,
                    "unexpected npm archive member")
            name = "/".join(parts[1:])
            require(name in git_files and name not in files, f"extra or duplicate archive member {name}")
            mode, kind, oid = git_files[name]
            data = package.extractfile(item).read()
            blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest().encode()
            require(kind == b"blob" and mode in {b"100644", b"100755"} and blob == oid,
                    f"archive member differs from Git: {name}")
            require(item.mode & 0o111 == int(mode, 8) & 0o111,
                    f"archive executable mode differs from Git: {name}")
            files[name] = digest(data)
    return files


def installed_inventory(directory):
    root = directory / "node_modules/backend-skeleton"
    require(root.is_dir() and not root.is_symlink(), "expected a physical installed package")
    installed = {}
    for file in root.rglob("*"):
        require(not file.is_symlink(), "unexpected symlink inside installed package")
        if file.is_file():
            installed[file.relative_to(root).as_posix()] = (digest(file.read_bytes()), stat.S_IMODE(file.stat().st_mode))
    return installed


def sandbox_environment(work):
    return {"PATH": os.environ.get("PATH", "/opt/homebrew/bin:/usr/bin:/bin"), "HOME": str(work),
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0",
            "NPM_CONFIG_USERCONFIG": os.devnull, "NPM_CONFIG_CACHE": str(work / "npm-cache"),
            "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org", "NO_COLOR": "1"}


def npm_pack(source, destination, npm, env):
    info = json.loads(run([npm, "pack", "--ignore-scripts", "--json", "--pack-destination", str(destination)],
                          source, env))
    name = info[0]["filename"]
    require(Path(name).name == name and name.startswith("backend-skeleton-"), "unexpected package name")
    return destination / name


def exercise_pair(work, previous, current, old_files, new_files, npm, node, env):
    consumer = work / "consumer"
    consumer.mkdir()
    (consumer / "package.json").write_text('{"name":"t03-pair-consumer","private":true}\n')
    sentinel = consumer / "consumer-state.txt"
    sentinel.write_bytes(b"independent consumer state\n")

    def install(archive, expected):
        run([npm, "install", "--ignore-scripts", "--no-fund", "--no-audit", str(archive)], consumer, env, timeout=180)
        require(sentinel.read_bytes() == b"independent consumer state\n", "consumer state changed")
        inventory = installed_inventory(consumer)
        require({name: value[0] for name, value in inventory.items()} == expected,
                "installed package files differ from their pinned archive")
        require(run([node, "node_modules/backend-skeleton/bin/bskel.mjs", "--version"], consumer, env).strip(),
                "installed CLI returned no version")
        return inventory

    before = install(previous, old_files)
    install(current, new_files)
    probe = [node, "--input-type=module", "-e", PROBE]
    outcome = json.loads(run(probe, consumer, env))
    require(install(previous, old_files) == before, "normal reinstall did not restore previous files and modes")
    install(current, new_files)
    with subprocess.Popen([*probe, "--", "hold"], cwd=consumer, env=env,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as child:
        try:
            readable, _, _ = select.select([child.stdout], [], [], 20)
            require(readable and json.loads(child.stdout.readline()) == outcome, "candidate interruption probe did not become ready")
            child.terminate()
            require(child.wait(timeout=10) == -signal.SIGTERM, "candidate probe did not stop by SIGTERM")
        finally:
            if child.poll() is None:
                child.kill()
    require(install(previous, old_files) == before, "interrupted-probe reinstall did not restore previous files and modes")
    return {"previous_installed_inventory_sha256": digest(json.dumps(before, sort_keys=True).encode()),
            "normal_restore": True, "sigterm_probe_restore": True, "outcome": outcome,
            "node": run([node, "--version"], consumer, env).decode().strip(),
            "npm": run([npm, "--version"], consumer, env).decode().strip(),
            "release_authorized": False, "runtime_certified": False}

REPO = "popixoxipop-collab/backend-skeleton"
REPO_ID = 1334919554
BOT_ID = 361175685
API = f"https://api.github.com/repos/{REPO}"
OBJECT_ID = re.compile(r"[0-9a-f]{40}")
EXPECTED_PATHS = {
    "test/capability-next/historical-installed-pair.test.mjs",
    "test/capability-next/historical-installed-probe.mjs",
}


def oid(value):
    if not OBJECT_ID.fullmatch(value):
        raise argparse.ArgumentTypeError("expected a full lower-case Git object ID")
    return value


def github(endpoint):
    request = Request(API + endpoint, headers={"Accept": "application/vnd.github+json",
                                             "User-Agent": "t00-t03-exact-replay/2"})
    with urlopen(request, timeout=30) as response:
        require(response.url == API + endpoint, "GitHub API redirected")
        data = response.read(2_000_001)
        require(len(data) <= 2_000_000, "GitHub response exceeds scope limit")
        return json.loads(data)


def pr_target(pull, args):
    head, base, author = pull["head"], pull["base"], pull["user"]
    require(pull["number"] == args.pr and head["sha"] == args.head, "PR moved or differs")
    require(author["id"] == BOT_ID and author["type"] == "Bot", "PR is outside the Dot Bot publication lane")
    for side in (head, base):
        require(side["repo"]["id"] == REPO_ID and side["repo"]["full_name"] == REPO,
                "PR must originate and land in BSKEL")
    require(head["ref"] == f"dot/t00-publisher/{args.head}" and base["ref"] == "main", "PR ref mismatch")
    require(pull["body"].splitlines().count("T00-Track: T03") == 1, "T03 track marker missing or ambiguous")
    if args.phase == "premerge":
        require(pull["state"] == "open" and pull["merged"] is False and base["sha"] == args.base,
                "premerge PR scope is stale")
        return args.head
    require(pull["state"] == "closed" and pull["merged"] is True and pull["draft"] is False,
            "postmerge requires a merged PR")
    return oid(pull["merge_commit_sha"])


def require_ancestor(expected, current, api):
    if current != expected:
        compare = api(f"/compare/{expected}...{current}?per_page=1")
        require(compare["status"] == "ahead" and compare["merge_base_commit"]["sha"] == expected,
                "the tested merge is outside protected main history")


def verify_main(expected, api=github, historical=False):
    main = api("/branches/main")
    require(main["name"] == "main" and main["protected"] is True, "main is not protected")
    current = oid(main["commit"]["sha"])
    if historical:
        require_ancestor(expected, current, api)
    else:
        require(current == expected, "protected main does not match the replay phase")


def changed_paths(changes):
    fields = changes.split(b"\0")
    require(fields[-1] == b"" and len(fields) == 2 * len(EXPECTED_PATHS) + 1, "unexpected diff length")
    paths = []
    for offset in range(0, len(fields) - 1, 2):
        status, name = (item.decode() for item in fields[offset:offset + 2])
        require(status in {"A", "M"} and name in EXPECTED_PATHS, "change exceeds the T03-06 evidence scope")
        paths.append(name)
    require(set(paths) == EXPECTED_PATHS, "T03-06 evidence set differs")
    return sorted(paths)


def parents(git, commit):
    header = git("cat-file", "commit", commit).split(b"\n\n", 1)[0].splitlines()
    return [line.decode()[7:] for line in header if line.startswith(b"parent ")]


def verify_replay(work, original_archive, args, api=github):
    if original_archive is not None:
        require(original_archive.is_file() and not original_archive.is_symlink()
                and digest(original_archive.read_bytes()) == HISTORICAL_PACKAGE_SHA,
                "historical installed package SHA mismatch")
    source = work / "source"
    source.mkdir()
    env = sandbox_environment(work)
    npm = shutil.which("npm", path=env["PATH"])
    node = shutil.which("node", path=env["PATH"])
    require(npm and node, "Node and npm are required")

    def git(*argv, timeout=55):
        return run(["git", "--literal-pathspecs", "-c", "credential.helper=", *argv],
                   source, env, timeout=timeout)

    target = pr_target(api(f"/pulls/{args.pr}"), args)
    postmerge = args.phase == "postmerge"
    expected_main = target if postmerge else args.base
    verify_main(expected_main, api, historical=postmerge)
    git("init", "--quiet")
    exact_merge_ref = [f"{target}:refs/t00/merged"] if postmerge else []
    git("fetch", "--quiet", "--no-tags", "--depth=1", REMOTE,
        f"{PREVIOUS}:refs/t00/previous", f"{HISTORICAL_PACKAGE_COMMIT}:refs/t00/historical",
        f"{args.base}:refs/t00/base", f"refs/pull/{args.pr}/head:refs/t00/head",
        "refs/heads/main:refs/t00/main", *exact_merge_ref, timeout=150)
    current = oid(git("rev-parse", "refs/t00/main").decode().strip())
    if postmerge:
        require(git("rev-parse", "refs/t00/merged").decode().strip() == target, "exact merge ref differs")
        require_ancestor(expected_main, current, api)
    else:
        require(current == expected_main, "Git main moved")
    require(git("rev-parse", "refs/t00/head").decode().strip() == args.head, "Git candidate head changed")
    for commit, tree in ((PREVIOUS, PREVIOUS_TREE), (HISTORICAL_PACKAGE_COMMIT, HISTORICAL_PACKAGE_TREE),
                         (args.base, args.base_tree), (args.head, args.head_tree), (target, args.head_tree)):
        require(git("rev-parse", f"{commit}^{{tree}}").decode().strip() == tree, "Git tree differs from independent pin")
    require(parents(git, args.head) == [args.base], "candidate must have a single protected base parent")
    if args.phase == "postmerge":
        require(parents(git, target) == [args.base, args.head], "merge has unexpected parents")
    paths = changed_paths(git("diff", "--name-status", "-z", "--no-renames", args.base, args.head))
    changed = git("ls-tree", "-r", "-z", args.head, "--", *paths).split(b"\0")[:-1]
    require(len(changed) == len(paths) and all(row.startswith(b"100644 blob ") for row in changed),
            "each evidence path must remain a regular non-executable Git blob")

    if original_archive is None:
        folder = work / "reproduced-historical"
        folder.mkdir()
        git("checkout", "--quiet", "--detach", HISTORICAL_PACKAGE_COMMIT)
        archive = npm_pack(source, folder, npm, env)
        archive_kind = "reproduced-from-pinned-historical-tree"
        archive_sha = digest(archive.read_bytes())
        require(archive_sha == REPRODUCED_HISTORICAL_PACKAGE_SHA, "reproduced historical archive SHA mismatch")
    else:
        archive = original_archive
        archive_kind = "original-historical-archive"
        archive_sha = HISTORICAL_PACKAGE_SHA
    historical = archive_inventory(archive, git("ls-tree", "-r", "-z", HISTORICAL_PACKAGE_COMMIT))
    inventories = {}
    archives = {}
    for label, commit in (("previous", PREVIOUS), ("base", args.base), ("candidate", target)):
        folder = work / label
        folder.mkdir()
        git("checkout", "--quiet", "--detach", commit)
        archive = npm_pack(source, folder, npm, env)
        archives[label] = archive
        inventories[label] = archive_inventory(archive, git("ls-tree", "-r", "-z", commit))
    previous = inventories["previous"]
    require(MODULE not in previous and MODULE in historical and
            inventories["base"] == historical == inventories["candidate"],
            "base and candidate packages must match the historically trusted package contents")
    result = exercise_pair(work, archives["previous"], archives["candidate"], previous, historical, npm, node, env)
    require(pr_target(api(f"/pulls/{args.pr}"), args) == target, "PR moved during replay")
    verify_main(expected_main, api, historical=postmerge)
    return {
        "schema": "t00.t03-exact-pr-replay/3", "phase": args.phase, "pull_request": args.pr,
        "base": args.base, "base_tree": args.base_tree, "source_head": args.head,
        "tested_commit": target, "tested_tree": args.head_tree, "scope_paths": paths,
        "historical_archive_sha256": HISTORICAL_PACKAGE_SHA,
        "replayed_historical_archive_sha256": archive_sha, "historical_archive_kind": archive_kind,
        "base_archive_sha256": digest(archives["base"].read_bytes()),
        "candidate_archive_sha256": digest(archives["candidate"].read_bytes()),
        "package_file_bytes_match_official_baseline": True, "package_members": len(historical),
        "candidate_tests_executed": False, "requires_separate_github_ci_and_authority": True, **result,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pr", type=int)
    parser.add_argument("phase", choices=("premerge", "postmerge"))
    for name in ("base", "base-tree", "head", "head-tree"):
        parser.add_argument("--" + name, type=oid, required=True)
    archive_input = parser.add_mutually_exclusive_group(required=True)
    archive_input.add_argument("--historical-archive", type=Path)
    archive_input.add_argument("--reproduce-historical-archive", action="store_true")
    args = parser.parse_args()
    require(0 < args.pr < 100_000_000, "invalid PR number")
    archive = args.historical_archive.absolute() if args.historical_archive else None
    with tempfile.TemporaryDirectory(prefix="t00-t03-exact-replay-") as temporary:
        result = verify_replay(Path(temporary), archive, args)
    print(json.dumps(result, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
