#!/usr/bin/env python3
"""Trusted, read-only T14-06 historical installed-package and preview replay."""

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


REPO = "popixoxipop-collab/backend-skeleton"
REPO_ID = 1334919554
BOT_ID = 361175685
API = f"https://api.github.com/repos/{REPO}"
REMOTE = f"https://github.com/{REPO}.git"
HISTORY = {
    "previous": (
        "271d5d747d7ef99fb7ce990a95db32fbdf4e46bd",
        "c5f1da277f3858cc93cefa8b6c3c0d5956b23e07",
        "9f2c2b705ddf6f7e9bd4ed03a7d4d6fb8ce002fbd46709f948ea99aa4e783ac8",
        "e32a0d3d34c46534f3a423fb1623e61e78965247bbd43f1c4c625d0922239e31",
    ),
    "introduced": (
        "bb18182c54a3a8f682ed2d1a6bac26749fcf267e",
        "3330ac643682236547425436179a8d09cb33bbec",
        "055e93ed6cde2c58f7fe7b1cfecedbf1375eda3be44ac3e9fa78168c43802a85",
        "cfe99556d4531269d87a213f3320a584d7d23653de33a6bb36f2d7d4aee588fb",
    ),
}
# Pin each Linux encoding from a completed reference receipt on the hosted runner.
LINUX_ARCHIVE_SHA256 = {}
NODE_VERSION = "v26.7.0"
NPM_VERSION = "11.19.0"
MODULE = "handles/composition-next/plan.mjs"
EVIDENCE_PATHS = frozenset({
    "next/t14/HISTORICAL_PACKAGE_REPLAY.json",
    "next/t14/HISTORICAL_PACKAGE_REPLAY.md",
})
PROBE = Path(__file__).resolve().with_name("t14-installed-preview-probe.mjs")
MAX_PACKAGE_MEMBER = 12 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def oid(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise argparse.ArgumentTypeError("expected an exact lower-case Git object id")
    return value


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def run(command, directory, env, timeout=90):
    result = subprocess.run(command, cwd=directory, env=env, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{Path(command[0]).name} {command[1]} exited {result.returncode}")
    return result.stdout


def github(endpoint):
    url = API + endpoint
    request = Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "t00-t14-product-replay"})
    with urlopen(request, timeout=15) as response:
        require(response.url == url, "GitHub API redirected")
        data = response.read(2_000_001)
        require(len(data) <= 2_000_000, "GitHub response exceeds proof limit")
        return json.loads(data)


def clean_env(work):
    home = work / "home"
    home.mkdir()
    user_config = work / "npm-user"
    global_config = work / "npm-global"
    user_config.touch()
    global_config.touch()
    return {
        "PATH": os.environ.get("PATH", "/opt/homebrew/bin:/usr/bin:/bin"), "HOME": str(home),
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0",
        "GIT_ALLOW_PROTOCOL": "https", "NPM_CONFIG_USERCONFIG": str(user_config),
        "NPM_CONFIG_GLOBALCONFIG": str(global_config), "NPM_CONFIG_CACHE": str(work / "npm-cache"),
        "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org", "NPM_CONFIG_IGNORE_SCRIPTS": "true",
        "NPM_CONFIG_UPDATE_NOTIFIER": "false", "NO_COLOR": "1", "LANG": "C.UTF-8",
    }


def archive_inventory(archive, git_tree):
    tracked = {}
    for entry in git_tree.split(b"\0")[:-1]:
        metadata, name = entry.split(b"\t", 1)
        tracked[name.decode()] = metadata.split()
    inventory = {}
    with tarfile.open(archive, "r:gz") as package:
        for entry in package:
            path = PurePosixPath(entry.name)
            require(entry.isfile() and len(path.parts) > 1 and path.parts[0] == "package" and
                    ".." not in path.parts and 0 <= entry.size <= MAX_PACKAGE_MEMBER, "invalid npm archive member")
            name = PurePosixPath(*path.parts[1:]).as_posix()
            require(name in tracked and name not in inventory, "untracked or duplicate npm archive member")
            mode, kind, expected_blob = tracked[name]
            require(kind == b"blob" and mode in {b"100644", b"100755"}, "npm archive differs from Git mode")
            content = package.extractfile(entry).read()
            actual_blob = hashlib.sha1(b"blob " + str(len(content)).encode() + b"\0" + content).hexdigest().encode()
            executable = entry.mode & 0o111 != 0
            require(actual_blob == expected_blob and executable == (mode == b"100755"),
                    f"npm archive bytes or mode differ from Git: {name}")
            inventory[name] = [digest(content), executable]
    require(inventory and "package.json" in inventory, "npm archive has no package")
    return inventory


def installed_inventory(root):
    require(root.is_dir() and not root.is_symlink(), "expected a physical install directory")
    inventory = {}
    for item in root.rglob("*"):
        require(not item.is_symlink(), "fixture or installed package contains a symlink")
        if item.is_file():
            mode = stat.S_IMODE(item.stat().st_mode)
            inventory[item.relative_to(root).as_posix()] = [digest(item.read_bytes()), mode]
    return inventory


def verify_archive_install(observed, expected):
    require({name: [item[0], item[1] & 0o111 != 0] for name, item in observed.items()} == expected,
            "physical install bytes or executable modes differ from pinned archive")


def historical_encoding(commit, raw_sha256, darwin_sha256, archive_platform, observation):
    require(archive_platform in {"darwin", "linux"}, "unsupported historical archive platform")
    linux_sha256 = LINUX_ARCHIVE_SHA256.get(commit) if archive_platform == "linux" else None
    expected_sha256 = linux_sha256 or darwin_sha256
    permit_observation = archive_platform == "linux" and observation and linux_sha256 is None
    require(raw_sha256 == expected_sha256 or permit_observation, "historical npm archive encoding SHA differs")
    return {"archive_platform": archive_platform, "darwin_reference_archive_sha256": darwin_sha256}


def pack(source, destination, npm, env, git, commit, tree, expected_archive=None, expected_inventory=None,
         *, observe_linux_encoding=False):
    require((expected_archive is None) == (expected_inventory is None), "historical inventory and encoding pins are required")
    require(git("rev-parse", commit + "^{tree}").decode().strip() == tree, "exact historical Git tree differs")
    git("checkout", "--quiet", "--detach", commit)
    destination.mkdir()
    result = json.loads(run([npm, "pack", "--ignore-scripts", "--json", "--pack-destination", str(destination)],
                            source, env))
    require(len(result) == 1, "expected one packed artifact")
    name = result[0]["filename"]
    require(re.fullmatch(r"backend-skeleton-[0-9][a-zA-Z0-9.+-]*\.tgz", name), "unexpected pack filename")
    archive = destination / name
    require(archive.is_file() and not archive.is_symlink(), "missing packed archive")
    inventory = archive_inventory(archive, git("ls-tree", "-r", "-z", commit))
    inventory_sha256 = digest(json_bytes(inventory))
    require(expected_inventory is None or inventory_sha256 == expected_inventory,
            f"historical npm archive inventory SHA differs: {inventory_sha256} ({len(inventory)} members)")
    sha256 = digest(archive.read_bytes())
    encoding = {} if expected_archive is None else historical_encoding(
        commit, sha256, expected_archive, sys.platform, observe_linux_encoding)
    return archive, inventory, {
        "commit": commit, "tree": tree, "archive_sha256": sha256,
        "archive_inventory_sha256": inventory_sha256, "package_members": len(inventory),
        "kind": "reproduced-from-pinned-git-tree", **encoding,
    }


def preview_probe(work, npm, node, env, previous, tested):
    consumer = work / "consumer"
    consumer.mkdir()
    (consumer / "package.json").write_text('{"name":"t14-independent-consumer","private":true}\n')
    installed = consumer / "node_modules" / "backend-skeleton"
    fixture = work / "fixture"
    fixture.mkdir()
    (fixture / "sentinel.txt").write_bytes(b"T14 independent dry-run sentinel\n")
    before = installed_inventory(fixture)

    def install(pack_result):
        archive, expected, _ = pack_result
        run([npm, "install", "--ignore-scripts", "--no-fund", "--no-audit", str(archive)], consumer, env,
            timeout=150)
        actual = installed_inventory(installed)
        verify_archive_install(actual, expected)
        version = run([node, str(installed / "bin" / "bskel.mjs"), "--version"], consumer, env).decode().strip()
        require(bool(version), "installed package CLI reported no version")
        require(installed_inventory(fixture) == before, "provider fixture changed outside observation")
        return actual, version

    initial, previous_version = install(previous)
    require(MODULE not in initial, "rollback baseline unexpectedly exposes T14")
    promoted, promoted_version = install(tested)
    require(MODULE in promoted, "installed candidate contains no preview")
    command = [node, str(PROBE), str(installed.resolve()), str(fixture.resolve()), tested[2]["commit"]]
    observed = json.loads(run([*command, "once"], consumer, env))
    require(installed_inventory(installed) == promoted and installed_inventory(fixture) == before,
            "normal dry-run changed files")
    normal, _ = install(previous)
    require(normal == initial, "normal restoration differs from baseline")

    resumed, _ = install(tested)
    require(resumed == promoted, "candidate reinstall drifted")
    with subprocess.Popen([*command, "hold"], cwd=consumer, env=env,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as child:
        try:
            readable, _, _ = select.select([child.stdout], [], [], 25)
            require(readable and json.loads(child.stdout.readline()) == observed and child.poll() is None,
                    "interruptible probe did not reach its verified result")
            child.terminate()
            code = child.wait(timeout=10)
            require(code == -signal.SIGTERM, "probe did not terminate by SIGTERM")
        finally:
            if child.poll() is None:
                child.kill()
    require(installed_inventory(installed) == promoted and installed_inventory(fixture) == before,
            "interrupted dry-run changed files")
    interrupted, _ = install(previous)
    require(interrupted == initial, "SIGTERM restoration differs from baseline")
    return {
        "result": observed, "baseline_version": previous_version, "preview_version": promoted_version,
        "fixture_before_after_sha256": digest(json_bytes(before)),
        "baseline_installed_sha256": digest(json_bytes(initial)), "preview_installed_sha256": digest(json_bytes(promoted)),
        "normal_restored_sha256": digest(json_bytes(normal)), "sigterm_restored_sha256": digest(json_bytes(interrupted)),
        "normal_restore": True, "sigterm_probe_restore": True, "sigterm_probe_exit_code": code,
        "completed_install_commands": 5, "install_exit_code": 0, "preview_exit_code": 0,
    }


def verify_live_subject(args, api):
    pull = api(f"/pulls/{args.pr}")
    head = pull["head"]
    base = pull["base"]
    user = pull["user"]
    require(pull["number"] == args.pr and head["sha"] == args.head and
            head["ref"] == f"dot/t00-publisher/{args.head}" and base["ref"] == "main" and
            user["id"] == BOT_ID and user["type"] == "Bot" and
            all(side["repo"]["id"] == REPO_ID and side["repo"]["full_name"] == REPO for side in (head, base)) and
            (pull.get("body") or "").splitlines().count("T00-Track: T14") == 1, "PR is outside the T14 Dot lane")
    branch = api("/branches/main")
    require(branch["name"] == "main" and branch["protected"] is True, "main is not protected")
    main = oid(branch["commit"]["sha"])
    if args.phase == "premerge":
        require(pull["state"] == "open" and pull["merged"] is False and base["sha"] == args.base == main,
                "protected premerge base drifted")
        return args.head
    merger = pull.get("merged_by") or {}
    require(pull["state"] == "closed" and pull["merged"] is True and pull["draft"] is False and
            pull["merge_commit_sha"] == args.merge and merger.get("id") == BOT_ID and merger.get("type") == "Bot",
            "exact protected Bot merge is missing")
    if main != args.merge:
        comparison = api(f"/compare/{args.merge}...{main}?per_page=1")
        require(comparison["status"] == "ahead" and comparison["merge_base_commit"]["sha"] == args.merge,
                "exact merge is absent from protected main history")
    return args.merge


def candidate_evidence(base):
    previous = HISTORY["previous"]
    introduced = HISTORY["introduced"]
    body = {"schema": "t00.t14-evidence-request/1", "task": "T14-06", "historical_pr": 147,
            "scope": "historical-provider-preview-package-replay", "protected_base": base,
            "previous_archive_sha256": previous[2], "introduced_archive_sha256": introduced[2],
            "checks": ["isolated-provider-preview", "normal-restore", "sigterm-restore"]}
    return {
        "next/t14/HISTORICAL_PACKAGE_REPLAY.json": json.dumps(body, sort_keys=True, indent=2) + "\n",
        "next/t14/HISTORICAL_PACKAGE_REPLAY.md": (
            "# T14-06 historical provider preview replay\n\n"
            f"Protected base `{base}`. Historical package pair recorded by PR #147.\n\n"
            "The independent replay verifies an isolated TypeORM preview, Prisma rejection,\n"
            "and restoration after normal completion and SIGTERM. It publishes the package\n"
            "and restore hashes as an artifact for the exact candidate and protected merge.\n"
        ),
    }


def verify_changed_files(git, args):
    fields = git("diff", "--name-status", "-z", "--no-renames", args.base, args.head).split(b"\0")
    require(fields[-1] == b"" and len(fields) == 2 * len(EVIDENCE_PATHS) + 1, "T14 evidence diff size differs")
    seen = set()
    for offset in range(0, len(fields) - 1, 2):
        status, name = (field.decode() for field in fields[offset:offset + 2])
        require(status in {"A", "M"} and name in EVIDENCE_PATHS, "changed file is outside T14 proof scope")
        seen.add(name)
    require(seen == EVIDENCE_PATHS, "missing T14 evidence path")
    modes = git("ls-tree", "-r", "-z", args.head, "--", *sorted(seen)).split(b"\0")[:-1]
    require(len(modes) == len(seen) and all(row.startswith(b"100644 blob ") for row in modes),
            "T14 replay evidence must remain regular nonexecutable Git blobs")
    for name, text in candidate_evidence(args.base).items():
        blob = args.head + ":" + name
        expected = text.encode()
        require(git("cat-file", "-s", blob).strip() == str(len(expected)).encode() and
                git("cat-file", "blob", blob) == expected, "T14 replay request or scope document differs")
    return sorted(seen)


def parents(git, commit):
    header = git("cat-file", "commit", commit).split(b"\n\n", 1)[0].splitlines()
    return [line[7:].decode() for line in header if line.startswith(b"parent ")]


def replay(work, args, api=github):
    env = clean_env(work)
    npm = shutil.which("npm", path=env["PATH"])
    node = shutil.which("node", path=env["PATH"])
    require(npm and node, "Node and npm required")
    require(run([node, "--version"], work, env).decode().strip() == NODE_VERSION and
            run([npm, "--version"], work, env).decode().strip() == NPM_VERSION, "pinned replay toolchain differs")
    source = work / "source"
    source.mkdir()

    def git(*arguments):
        return run(["git", "--literal-pathspecs", "-c", "credential.helper=", *arguments], source, env, timeout=150)

    git("init", "--quiet")
    refs = [f"{pin[0]}:refs/t14/{name}" for name, pin in HISTORY.items()]
    reference = args.phase == "reference"
    tested_oid = HISTORY["introduced"][0] if reference else verify_live_subject(args, api)
    if not reference:
        refs.extend([f"{args.base}:refs/t14/base", f"refs/pull/{args.pr}/head:refs/t14/head"])
        if args.phase == "postmerge":
            refs.append(f"{tested_oid}:refs/t14/merge")
    git("fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--depth=1", REMOTE, *refs)
    for name, (commit, _, _, _) in HISTORY.items():
        require(git("rev-parse", f"refs/t14/{name}").decode().strip() == commit, "historical Git ref differs")
    previous, introduced = [pack(source, work / name, npm, env, git, *HISTORY[name],
                                 observe_linux_encoding=reference) for name in HISTORY]
    require(MODULE not in previous[1] and MODULE in introduced[1], "historical T14 introduction did not reproduce")
    if reference and sys.platform == "linux":
        print("T14 verified historical Linux archives " + json.dumps({
            "previous": previous[2], "introduced": introduced[2],
        }, sort_keys=True), file=sys.stderr)
    scope = []
    if reference:
        tested = introduced
        baseline = None
    else:
        require(git("rev-parse", "refs/t14/head").decode().strip() == args.head, "candidate head moved")
        require(git("rev-parse", args.head + "^{tree}").decode().strip() == args.head_tree, "candidate tree differs")
        require(parents(git, args.head) == [args.base],
                "candidate must be the single child of the exact protected base")
        if args.phase == "postmerge":
            require(git("rev-parse", "refs/t14/merge").decode().strip() == tested_oid and
                    parents(git, tested_oid) == [args.base, args.head],
                    "merge object parents differ")
        scope = verify_changed_files(git, args)
        baseline = pack(source, work / "protected-base", npm, env, git, args.base, args.base_tree)
        tested = pack(source, work / "tested", npm, env, git, tested_oid, args.head_tree)
        require(baseline[1] == tested[1] and baseline[2]["archive_sha256"] == tested[2]["archive_sha256"],
                "evidence-only candidate changed packaged bytes")

    installed = preview_probe(work, npm, node, env, previous, tested)
    if not reference:
        require(verify_live_subject(args, api) == tested_oid, "protected PR subject moved during replay")
    return {
        "schema": "t00.t14-exact-installed-preview-replay/1", "phase": args.phase, "track": "T14",
        "task": "T14-06", "pull_request": args.pr, "base": args.base, "base_tree": args.base_tree,
        "source_head": args.head, "tested_commit": tested_oid, "tested_tree": tested[2]["tree"],
        "scope_paths": scope, "published_candidate_validated": not reference,
        "historical_pr": 147, "historical_previous": previous[2], "historical_introduced": introduced[2],
        "protected_base": baseline[2] if baseline else None, "tested_package": tested[2], "installed_probe": installed,
        "node": NODE_VERSION, "npm": NPM_VERSION, "candidate_tests_executed": False,
        "verifier_sha256": digest(Path(__file__).resolve().read_bytes()), "probe_sha256": digest(PROBE.read_bytes()),
        "runtime_certified": False, "release_authorized": False,
        "requires_separate_github_ci_and_authority": True,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("reference", "premerge", "postmerge", "candidate-evidence"))
    parser.add_argument("--pr", type=int)
    for name in ("base", "base-tree", "head", "head-tree", "merge"):
        parser.add_argument("--" + name, type=oid)
    args = parser.parse_args()
    if args.phase == "candidate-evidence":
        require(args.base is not None and all(value is None for value in (args.pr, args.base_tree, args.head,
                args.head_tree, args.merge)), "candidate evidence input takes only a protected base")
        print(json.dumps(candidate_evidence(args.base), sort_keys=True))
        return
    fields = (args.pr, args.base, args.base_tree, args.head, args.head_tree)
    if args.phase == "reference":
        require(all(value is None for value in (*fields, args.merge)), "reference input takes no candidate arguments")
    else:
        require(all(value is not None for value in fields) and 0 < args.pr < 100_000_000 and args.pr != 389 and
                args.base != args.head, "candidate input must pin PR, commits and trees")
        require((args.phase == "premerge" and args.merge is None) or
                (args.phase == "postmerge" and args.merge and args.merge not in {args.base, args.head}),
                "invalid merge input for replay phase")
    with tempfile.TemporaryDirectory(prefix="t00-t14-installed-replay-") as temp:
        result = replay(Path(temp), args)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
