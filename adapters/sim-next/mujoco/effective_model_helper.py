#!/usr/bin/env python3
"""T24 M3 MuJoCo effective-model compiler helper.

This program is intentionally a compiler-only helper. It validates an exact staged
source closure, imports a pinned MuJoCo package, constructs MjModel, and emits
compiled model facts. It never constructs MjData, steps physics, renders, opens a
network client, or executes target application/build scripts.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import posixpath
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
from typing import Any

REQUEST_PROTOCOL = "sbf.sim-mujoco-effective-helper-request/draft-1"
RESPONSE_PROTOCOL = "sbf.sim-mujoco-effective-helper-response/draft-1"
EFFECTIVE_MODEL_SCHEMA = "sbf.sim-mujoco-effective-model/draft-1"
ARTIFACT_REF_VERSION = "sbf.artifact-ref/1"
SUPPORTED_MUJOCO_VERSION = "3.12.0"

MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_SOURCE_FILES = 10_000
MAX_STAGING_ENTRIES = 20_000
MAX_SOURCE_BYTES = 1024 * 1024 * 1024
MAX_TEXT_LENGTH = 4096
MAX_PREFLIGHT_XML_BYTES = 8 * 1024 * 1024
MAX_PREFLIGHT_XML_ELEMENTS = 20_000
MAX_PREFLIGHT_XML_DEPTH = 64
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
MEDIA_TYPE_RE = re.compile(r"^[^\s/]+/[^\s]+$")
URI_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")

JOINT_WIDTHS = {
    "free": (7, 6),
    "ball": (4, 3),
    "slide": (1, 1),
    "hinge": (1, 1),
}

JOINT_ENUMS = {
    "FREE": "free",
    "BALL": "ball",
    "SLIDE": "slide",
    "HINGE": "hinge",
}

TRANSMISSION_ENUMS = {
    "JOINT": "joint",
    "JOINTINPARENT": "jointinparent",
    "SLIDERCRANK": "slidercrank",
    "TENDON": "tendon",
    "SITE": "site",
    "BODY": "body",
}

INTEGRATOR_NAMES = {
    "EULER": "Euler",
    "RK4": "RK4",
    "IMPLICIT": "implicit",
    "IMPLICITFAST": "implicitfast",
}


class HelperError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _control_free_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or len(value) > MAX_TEXT_LENGTH:
        raise HelperError("REQUEST_INVALID", f"{label} must be a bounded non-empty string")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        raise HelperError("REQUEST_INVALID", f"{label} must not contain control characters")
    return value


def _exact_keys(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HelperError("REQUEST_INVALID", f"{label} must be an object")
    actual = set(value.keys())
    extra = sorted(actual - keys)
    missing = sorted(keys - actual)
    if extra:
        raise HelperError("REQUEST_INVALID", f"{label} contains unsupported fields: {', '.join(extra)}")
    if missing:
        raise HelperError("REQUEST_INVALID", f"{label} is missing required fields: {', '.join(missing)}")
    return value


def _logical_path(value: Any, label: str) -> str:
    value = _control_free_text(value, label)
    if (
        "\\" in value
        or value.startswith("/")
        or URI_RE.match(value)
        or any(part in ("", ".", "..") for part in value.split("/"))
    ):
        raise HelperError(
            "REQUEST_INVALID",
            f"{label} must be a repo-relative POSIX path without dot/parent segments",
        )
    return value


def _artifact_ref(
    value: Any,
    label: str,
    *,
    family: str,
    version: str = "draft-1",
) -> dict[str, Any]:
    value = _exact_keys(
        value,
        {"artifact_ref", "family", "version", "media_type", "byte_sha256", "size_bytes"},
        label,
    )
    if value["artifact_ref"] != ARTIFACT_REF_VERSION:
        raise HelperError("REQUEST_INVALID", f"{label}.artifact_ref is invalid")
    if value["family"] != family:
        raise HelperError("REQUEST_INVALID", f"{label}.family must be {family}")
    if value["version"] != version:
        raise HelperError("REQUEST_INVALID", f"{label}.version must be {version}")
    if not isinstance(value["media_type"], str) or not MEDIA_TYPE_RE.match(value["media_type"]):
        raise HelperError("REQUEST_INVALID", f"{label}.media_type is invalid")
    if not isinstance(value["byte_sha256"], str) or not SHA256_RE.match(value["byte_sha256"]):
        raise HelperError("REQUEST_INVALID", f"{label}.byte_sha256 is invalid")
    if (
        not isinstance(value["size_bytes"], int)
        or isinstance(value["size_bytes"], bool)
        or value["size_bytes"] < 0
    ):
        raise HelperError("REQUEST_INVALID", f"{label}.size_bytes is invalid")
    return {
        "artifact_ref": ARTIFACT_REF_VERSION,
        "family": family,
        "version": version,
        "media_type": value["media_type"],
        "byte_sha256": value["byte_sha256"],
        "size_bytes": value["size_bytes"],
    }


def _source_entry(value: Any, label: str, *, role_required: bool) -> dict[str, Any]:
    expected = {"path", "role", "artifact"} if role_required else {"path", "artifact"}
    value = _exact_keys(value, expected, label)
    path = _logical_path(value["path"], f"{label}.path")
    out: dict[str, Any] = {
        "path": path,
        "artifact": _artifact_ref(
            value["artifact"],
            f"{label}.artifact",
            family="simulation-source",
        ),
    }
    if role_required:
        if value["role"] not in ("include", "asset"):
            raise HelperError("REQUEST_INVALID", f"{label}.role must be include or asset")
        out["role"] = value["role"]
    return out


def validate_request(value: Any) -> dict[str, Any]:
    value = _exact_keys(
        value,
        {"protocol", "target", "source_bundle", "helper_artifact"},
        "MuJoCo helper request",
    )
    if value["protocol"] != REQUEST_PROTOCOL:
        raise HelperError("REQUEST_INVALID", "MuJoCo helper request protocol is invalid")
    if value["target"] != "SIM-mujoco":
        raise HelperError("REQUEST_INVALID", "MuJoCo helper request target must be SIM-mujoco")

    source = _exact_keys(value["source_bundle"], {"root", "dependencies"}, "source_bundle")
    root = _source_entry(source["root"], "source_bundle.root", role_required=False)
    if not isinstance(source["dependencies"], list):
        raise HelperError("REQUEST_INVALID", "source_bundle.dependencies must be an array")
    if len(source["dependencies"]) > MAX_SOURCE_FILES - 1:
        raise HelperError(
            "REQUEST_INVALID",
            f"source_bundle exceeds file-count limit {MAX_SOURCE_FILES}",
        )
    dependencies = [
        _source_entry(entry, f"source_bundle.dependencies[{index}]", role_required=True)
        for index, entry in enumerate(source["dependencies"])
    ]
    seen = {root["path"]}
    for entry in dependencies:
        if entry["path"] in seen:
            raise HelperError(
                "REQUEST_INVALID",
                f"source_bundle contains duplicate logical path: {entry['path']}",
            )
        seen.add(entry["path"])

    helper_artifact = _artifact_ref(
        value["helper_artifact"],
        "helper_artifact",
        family="simulation-helper",
    )
    return {
        "protocol": REQUEST_PROTOCOL,
        "target": "SIM-mujoco",
        "source_bundle": {"root": root, "dependencies": dependencies},
        "helper_artifact": helper_artifact,
    }


def _hash_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_SOURCE_BYTES:
                raise HelperError("SOURCE_CLOSURE_INVALID", "source file exceeds helper byte budget")
            digest.update(chunk)
    return digest.hexdigest(), size


def _verify_exact_file(path: Path, artifact: dict[str, Any], *, helper: bool = False) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        code = "HELPER_ARTIFACT_MISMATCH" if helper else "SOURCE_CLOSURE_INVALID"
        raise HelperError(code, f"required file is missing: {path.name}") from exc
    if path.is_symlink() or not path.is_file():
        code = "HELPER_ARTIFACT_MISMATCH" if helper else "SOURCE_CLOSURE_INVALID"
        raise HelperError(code, f"required path is not a regular non-symlink file: {path.name}")
    digest, size = _hash_file(path)
    if digest != artifact["byte_sha256"] or size != artifact["size_bytes"]:
        code = "HELPER_ARTIFACT_MISMATCH" if helper else "SOURCE_CLOSURE_INVALID"
        raise HelperError(code, f"exact bytes do not match ArtifactRef: {path.name}")
    # Keep the lstat result live so linters/readers can see the no-follow intent explicitly.
    del info


def _inventory_staging(root: Path) -> set[str]:
    files: set[str] = set()
    stack = [root]
    entries = 0
    while stack:
        directory = stack.pop()
        with os.scandir(directory) as iterator:
            for entry in iterator:
                entries += 1
                if entries > MAX_STAGING_ENTRIES:
                    raise HelperError(
                        "SOURCE_CLOSURE_INVALID",
                        f"staging root exceeds entry limit {MAX_STAGING_ENTRIES}",
                    )
                if entry.is_symlink():
                    raise HelperError(
                        "SOURCE_CLOSURE_INVALID",
                        f"staging root contains symlink: {Path(entry.path).relative_to(root).as_posix()}",
                    )
                if entry.is_dir(follow_symlinks=False):
                    stack.append(Path(entry.path))
                    continue
                if not entry.is_file(follow_symlinks=False):
                    raise HelperError(
                        "SOURCE_CLOSURE_INVALID",
                        f"staging root contains non-regular entry: {Path(entry.path).relative_to(root).as_posix()}",
                    )
                relative = Path(entry.path).relative_to(root).as_posix()
                files.add(relative)
                if len(files) > MAX_SOURCE_FILES:
                    raise HelperError(
                        "SOURCE_CLOSURE_INVALID",
                        f"staging root exceeds file-count limit {MAX_SOURCE_FILES}",
                    )
    return files


def verify_staged_source_closure(source_bundle: dict[str, Any], staging_root: Path) -> None:
    root = staging_root.resolve(strict=True)
    if not root.is_dir():
        raise HelperError("SOURCE_CLOSURE_INVALID", "helper cwd must be an approved staging directory")

    entries = [source_bundle["root"], *source_bundle["dependencies"]]
    expected = {entry["path"] for entry in entries}
    actual = _inventory_staging(root)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        details = []
        if missing:
            details.append("missing=" + ",".join(missing[:16]))
        if extra:
            details.append("extra=" + ",".join(extra[:16]))
        raise HelperError(
            "SOURCE_CLOSURE_INVALID",
            "staging file set does not equal source_bundle" + (": " + "; ".join(details) if details else ""),
        )

    total = 0
    for entry in entries:
        requested = root.joinpath(*entry["path"].split("/"))
        resolved = requested.resolve(strict=True)
        try:
            resolved.relative_to(root)
        except ValueError as exc:
            raise HelperError(
                "SOURCE_CLOSURE_INVALID",
                f"source path escapes staging root: {entry['path']}",
            ) from exc
        _verify_exact_file(resolved, entry["artifact"])
        total += entry["artifact"]["size_bytes"]
        if total > MAX_SOURCE_BYTES:
            raise HelperError(
                "SOURCE_CLOSURE_INVALID",
                f"source bundle exceeds aggregate byte limit {MAX_SOURCE_BYTES}",
            )

    _verify_compiler_read_closure(source_bundle, root)


def _safe_compiler_ref(value: Any, label: str) -> str:
    value = _control_free_text(value, label)
    if (
        "\\" in value
        or value.startswith("/")
        or URI_RE.match(value)
        or re.match(r"^[A-Za-z]:/", value)
    ):
        raise HelperError(
            "SOURCE_CLOSURE_INVALID",
            f"{label} must be a relative POSIX path inside the approved source bundle",
        )
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise HelperError(
            "SOURCE_CLOSURE_INVALID",
            f"{label} must not contain empty, dot, or parent segments",
        )
    normalized = posixpath.normpath(value)
    if normalized in (".", "..") or normalized.startswith("../") or posixpath.isabs(normalized):
        raise HelperError("SOURCE_CLOSURE_INVALID", f"{label} escapes the approved source bundle")
    return normalized


def _xml_tag(element: ET.Element) -> str:
    tag = element.tag
    if not isinstance(tag, str) or not tag or "}" in tag:
        raise HelperError(
            "SOURCE_CLOSURE_INVALID",
            "MJCF compiler preflight does not allow XML namespaces or non-string tags",
        )
    return tag


def _read_preflight_xml(staging_root: Path, entry: dict[str, Any]) -> ET.Element:
    if entry["artifact"]["size_bytes"] > MAX_PREFLIGHT_XML_BYTES:
        raise HelperError(
            "SOURCE_CLOSURE_INVALID",
            f"XML compiler input exceeds preflight byte limit {MAX_PREFLIGHT_XML_BYTES}: {entry['path']}",
        )
    source_path = staging_root.joinpath(*entry["path"].split("/"))
    data = source_path.read_bytes()
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise HelperError(
            "SOURCE_CLOSURE_INVALID",
            f"XML compiler input must be UTF-8: {entry['path']}",
        ) from exc
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, flags=re.IGNORECASE):
        raise HelperError(
            "SOURCE_CLOSURE_INVALID",
            f"XML compiler input must not declare DOCTYPE or ENTITY: {entry['path']}",
        )
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise HelperError(
            "SOURCE_CLOSURE_INVALID",
            f"XML compiler input is malformed: {entry['path']}",
        ) from exc

    stack: list[tuple[ET.Element, int]] = [(root, 1)]
    count = 0
    while stack:
        element, depth = stack.pop()
        count += 1
        if count > MAX_PREFLIGHT_XML_ELEMENTS:
            raise HelperError(
                "SOURCE_CLOSURE_INVALID",
                f"XML compiler input exceeds element limit {MAX_PREFLIGHT_XML_ELEMENTS}: {entry['path']}",
            )
        if depth > MAX_PREFLIGHT_XML_DEPTH:
            raise HelperError(
                "SOURCE_CLOSURE_INVALID",
                f"XML compiler input exceeds depth limit {MAX_PREFLIGHT_XML_DEPTH}: {entry['path']}",
            )
        _xml_tag(element)
        stack.extend((child, depth + 1) for child in list(element))
    return root


def _compiler_path_config(xml_roots: list[ET.Element]) -> dict[str, Any]:
    compiler_elements = [
        element
        for root in xml_roots
        for element in root.iter()
        if _xml_tag(element) == "compiler"
    ]
    if len(compiler_elements) > 1:
        raise HelperError(
            "SOURCE_CLOSURE_INVALID",
            "M3 compiler read-closure preflight supports at most one <compiler> element",
        )
    attrs = compiler_elements[0].attrib if compiler_elements else {}

    def directory(name: str) -> str | None:
        raw = attrs.get(name)
        if raw is None:
            return None
        return _safe_compiler_ref(raw, f"compiler.{name}")

    assetdir = directory("assetdir")
    meshdir = directory("meshdir") or assetdir
    texturedir = directory("texturedir") or assetdir

    strip_raw = attrs.get("strippath", "false").lower()
    if strip_raw not in ("true", "false"):
        raise HelperError(
            "SOURCE_CLOSURE_INVALID",
            "compiler.strippath must be true or false for M3 compiler preflight",
        )
    return {
        "meshdir": meshdir,
        "texturedir": texturedir,
        "strippath": strip_raw == "true",
    }


def _resolve_compiler_file(
    *,
    main_dir: str,
    directory: str | None,
    raw_ref: Any,
    strip_path: bool,
    label: str,
) -> str:
    ref = _safe_compiler_ref(raw_ref, label)
    if strip_path:
        ref = posixpath.basename(ref)
    pieces = []
    if main_dir != ".":
        pieces.append(main_dir)
    if directory is not None:
        pieces.append(directory)
    pieces.append(ref)
    resolved = posixpath.normpath(posixpath.join(*pieces))
    if resolved in (".", "..") or resolved.startswith("../") or posixpath.isabs(resolved):
        raise HelperError("SOURCE_CLOSURE_INVALID", f"{label} escapes the approved source bundle")
    return resolved


def _verify_compiler_read_closure(source_bundle: dict[str, Any], staging_root: Path) -> None:
    dependencies = {
        entry["path"]: entry
        for entry in source_bundle["dependencies"]
    }
    root_path = source_bundle["root"]["path"]
    main_dir = posixpath.dirname(root_path)

    xml_entries = [
        source_bundle["root"],
        *[
            entry
            for entry in source_bundle["dependencies"]
            if entry["role"] == "include"
        ],
    ]
    xml_roots = [_read_preflight_xml(staging_root, entry) for entry in xml_entries]
    config = _compiler_path_config(xml_roots)

    def require_dependency(path_value: str, role: str, label: str) -> None:
        entry = dependencies.get(path_value)
        if entry is None:
            raise HelperError(
                "SOURCE_CLOSURE_INVALID",
                f"{label} resolves to undeclared compiler input: {path_value}",
            )
        if entry["role"] != role:
            raise HelperError(
                "SOURCE_CLOSURE_INVALID",
                f"{label} resolves to {path_value}, declared as role {entry['role']} instead of {role}",
            )

    seen_includes: set[str] = set()
    asset_elements = {
        "mesh": ("meshdir", {"file"}),
        "hfield": ("meshdir", {"file"}),
        "skin": ("meshdir", {"file"}),
        "texture": (
            "texturedir",
            {"file", "fileup", "filedown", "fileleft", "fileright", "filefront", "fileback"},
        ),
    }

    for xml_root in xml_roots:
        for element in xml_root.iter():
            tag = _xml_tag(element)
            if tag in ("extension", "plugin") or "plugin" in element.attrib:
                raise HelperError(
                    "SOURCE_CLOSURE_INVALID",
                    f"M3 compiler read-closure preflight does not certify plugin/extension semantics: <{tag}>",
                )

            file_attrs = sorted(
                key
                for key in element.attrib
                if key == "file" or key.startswith("file")
            )
            if not file_attrs:
                continue

            if tag == "include":
                if file_attrs != ["file"]:
                    raise HelperError(
                        "SOURCE_CLOSURE_INVALID",
                        "include contains an unreviewed file-bearing attribute",
                    )
                ref = _safe_compiler_ref(element.attrib["file"], "include.file")
                resolved = _resolve_compiler_file(
                    main_dir=main_dir,
                    directory=None,
                    raw_ref=ref,
                    strip_path=False,
                    label="include.file",
                )
                if resolved in seen_includes:
                    raise HelperError(
                        "SOURCE_CLOSURE_INVALID",
                        f"MuJoCo include is referenced more than once: {resolved}",
                    )
                seen_includes.add(resolved)
                require_dependency(resolved, "include", "include.file")
                continue

            asset_rule = asset_elements.get(tag)
            if asset_rule is None:
                raise HelperError(
                    "SOURCE_CLOSURE_INVALID",
                    f"M3 compiler read-closure preflight does not certify file-bearing element <{tag}>",
                )

            directory_key, allowed_attrs = asset_rule
            unsupported = [key for key in file_attrs if key not in allowed_attrs]
            if unsupported:
                raise HelperError(
                    "SOURCE_CLOSURE_INVALID",
                    f"<{tag}> contains unreviewed file-bearing attribute(s): {', '.join(unsupported)}",
                )
            for attribute in file_attrs:
                resolved = _resolve_compiler_file(
                    main_dir=main_dir,
                    directory=config[directory_key],
                    raw_ref=element.attrib[attribute],
                    strip_path=config["strippath"],
                    label=f"{tag}.{attribute}",
                )
                require_dependency(resolved, "asset", f"{tag}.{attribute}")


def _enum_suffix(mj: Any, class_name: str, prefix: str, raw: Any) -> str:
    enum_class = getattr(mj, class_name, None)
    if enum_class is None:
        raise HelperError("MODEL_UNSUPPORTED", f"MuJoCo enum class unavailable: {class_name}")
    wanted = int(raw)
    for name in dir(enum_class):
        if not name.startswith(prefix):
            continue
        try:
            if int(getattr(enum_class, name)) == wanted:
                return name[len(prefix):]
        except (TypeError, ValueError):
            continue
    raise HelperError(
        "MODEL_UNSUPPORTED",
        f"unsupported {class_name} value: {wanted}",
    )


def _finite(value: Any, label: str) -> float:
    out = float(value)
    if not math.isfinite(out):
        raise HelperError("MODEL_UNSUPPORTED", f"{label} must be finite")
    return out


def _vector(value: Any, length: int, label: str) -> list[float]:
    try:
        row = list(value)
    except TypeError as exc:
        raise HelperError("MODEL_UNSUPPORTED", f"{label} must be an array") from exc
    if len(row) != length:
        raise HelperError("MODEL_UNSUPPORTED", f"{label} must contain {length} values")
    return [_finite(item, f"{label}[{index}]") for index, item in enumerate(row)]


def _compiled_name(mj: Any, model: Any, object_enum_name: str, object_id: int) -> str | None:
    object_class = getattr(mj, "mjtObj", None)
    if object_class is None or not hasattr(object_class, object_enum_name):
        raise HelperError("MODEL_UNSUPPORTED", f"MuJoCo object enum unavailable: {object_enum_name}")
    name = mj.mj_id2name(model, getattr(object_class, object_enum_name), object_id)
    if name is None or name == "":
        return None
    text = str(name)
    if len(text) > MAX_TEXT_LENGTH or any(ord(ch) < 32 or ord(ch) == 127 for ch in text):
        raise HelperError("MODEL_UNSUPPORTED", "compiled object name is not bounded/control-free")
    return text


def _count(model: Any, name: str) -> int:
    value = int(getattr(model, name))
    if value < 0:
        raise HelperError("MODEL_UNSUPPORTED", f"negative compiled model count: {name}")
    return value


def extract_effective_model(
    model: Any,
    mj: Any,
    *,
    source_bundle: dict[str, Any],
    helper_artifact: dict[str, Any],
    version: str,
) -> dict[str, Any]:
    if version != SUPPORTED_MUJOCO_VERSION:
        raise HelperError(
            "MUJOCO_VERSION_MISMATCH",
            f"MuJoCo version must be {SUPPORTED_MUJOCO_VERSION}, got {version}",
        )

    counts = {
        key: _count(model, key)
        for key in (
            "nbody", "njnt", "ngeom", "nsite", "ntendon",
            "nq", "nv", "na", "nu", "nactuator", "nout",
            "nsensor", "nsensordata",
        )
    }

    integrator_key = _enum_suffix(mj, "mjtIntegrator", "mjINT_", model.opt.integrator)
    integrator = INTEGRATOR_NAMES.get(integrator_key, integrator_key.lower())

    bodies = []
    for index in range(counts["nbody"]):
        bodies.append({
            "id": index,
            "name": _compiled_name(mj, model, "mjOBJ_BODY", index),
            "parent_id": int(model.body_parentid[index]),
        })

    joints = []
    for index in range(counts["njnt"]):
        joint_key = _enum_suffix(mj, "mjtJoint", "mjJNT_", model.jnt_type[index])
        joint_type = JOINT_ENUMS.get(joint_key)
        if joint_type is None:
            raise HelperError("MODEL_UNSUPPORTED", f"unsupported joint type: {joint_key}")
        qpos_width, dof_width = JOINT_WIDTHS[joint_type]
        limited = bool(model.jnt_limited[index])
        joints.append({
            "id": index,
            "name": _compiled_name(mj, model, "mjOBJ_JOINT", index),
            "body_id": int(model.jnt_bodyid[index]),
            "type": joint_type,
            "qpos_adr": int(model.jnt_qposadr[index]),
            "dof_adr": int(model.jnt_dofadr[index]),
            "qpos_width": qpos_width,
            "dof_width": dof_width,
            "limited": limited,
            "range": _vector(model.jnt_range[index], 2, f"joint {index} range") if limited else None,
        })

    geoms = []
    for index in range(counts["ngeom"]):
        geom_type = _enum_suffix(mj, "mjtGeom", "mjGEOM_", model.geom_type[index]).lower()
        geoms.append({
            "id": index,
            "name": _compiled_name(mj, model, "mjOBJ_GEOM", index),
            "body_id": int(model.geom_bodyid[index]),
            "type": geom_type,
            "contype": int(model.geom_contype[index]),
            "conaffinity": int(model.geom_conaffinity[index]),
        })

    sites = []
    for index in range(counts["nsite"]):
        sites.append({
            "id": index,
            "name": _compiled_name(mj, model, "mjOBJ_SITE", index),
            "body_id": int(model.site_bodyid[index]),
        })

    actuators = []
    for index in range(counts["nactuator"]):
        transmission_key = _enum_suffix(
            mj,
            "mjtTrn",
            "mjTRN_",
            model.actuator_trntype[index],
        )
        transmission_type = TRANSMISSION_ENUMS.get(transmission_key)
        if transmission_type is None:
            raise HelperError(
                "MODEL_UNSUPPORTED",
                f"unreviewed actuator transmission type: {transmission_key}",
            )

        control_adr = int(model.actuator_ctrladr[index])
        control_count = int(model.actuator_ctrlnum[index])
        controls = []
        for offset in range(control_count):
            control_index = control_adr + offset
            if control_index < 0 or control_index >= counts["nu"]:
                raise HelperError(
                    "MODEL_UNSUPPORTED",
                    f"actuator {index} control index is outside nu",
                )
            limited = bool(model.actuator_ctrllimited[control_index])
            controls.append({
                "limited": limited,
                "range": (
                    _vector(
                        model.actuator_ctrlrange[control_index],
                        2,
                        f"actuator {index} control {offset} range",
                    )
                    if limited else None
                ),
            })

        trnids = list(model.actuator_trnid[index])
        if len(trnids) != 2:
            raise HelperError("MODEL_UNSUPPORTED", f"actuator {index} trnid width must be 2")

        actuators.append({
            "id": index,
            "name": _compiled_name(mj, model, "mjOBJ_ACTUATOR", index),
            "transmission_type": transmission_type,
            "target_ids": [int(trnids[0]), int(trnids[1])],
            "control_adr": control_adr,
            "control_count": control_count,
            "controls": controls,
            "output_adr": int(model.actuator_outadr[index]),
            "output_count": int(model.actuator_outnum[index]),
            "activation_adr": int(model.actuator_actadr[index]),
            "activation_count": int(model.actuator_actnum[index]),
        })

    sensors = []
    for index in range(counts["nsensor"]):
        sensor_type = _enum_suffix(
            mj,
            "mjtSensor",
            "mjSENS_",
            model.sensor_type[index],
        ).lower()
        object_type = _enum_suffix(
            mj,
            "mjtObj",
            "mjOBJ_",
            model.sensor_objtype[index],
        ).lower()
        sensors.append({
            "id": index,
            "name": _compiled_name(mj, model, "mjOBJ_SENSOR", index),
            "type": sensor_type,
            "object_type": object_type,
            "object_id": int(model.sensor_objid[index]),
            "adr": int(model.sensor_adr[index]),
            "dim": int(model.sensor_dim[index]),
        })

    return {
        "schema": EFFECTIVE_MODEL_SCHEMA,
        "target": "SIM-mujoco",
        "source_bundle": source_bundle,
        "compiler": {
            "engine": "mujoco",
            "version": version,
            "build": None,
            "helper_artifact": helper_artifact,
        },
        "model": {
            "counts": counts,
            "options": {
                "timestep": _finite(model.opt.timestep, "model.options.timestep"),
                "gravity": _vector(model.opt.gravity, 3, "model.options.gravity"),
                "integrator": integrator,
            },
            "bodies": bodies,
            "joints": joints,
            "geoms": geoms,
            "sites": sites,
            "actuators": actuators,
            "sensors": sensors,
        },
        "claims": {
            "compiled_model_facts": True,
            "source_bundle_bound": True,
            "runtime_behavior_verified": False,
            "dynamic_state_observed": False,
        },
    }


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise HelperError("REQUEST_INVALID", f"request contains duplicate JSON key: {key}")
        out[key] = value
    return out


def _reject_json_constant(value: str) -> Any:
    raise HelperError("REQUEST_INVALID", f"request contains non-standard JSON number: {value}")


def _load_request() -> dict[str, Any]:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise HelperError(
            "REQUEST_INVALID",
            f"request exceeds byte limit {MAX_REQUEST_BYTES}",
        )
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise HelperError("REQUEST_INVALID", "request must be valid UTF-8") from exc
    try:
        value = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_json_keys,
            parse_constant=_reject_json_constant,
        )
    except json.JSONDecodeError as exc:
        raise HelperError("REQUEST_INVALID", "request must contain valid JSON") from exc
    return validate_request(value)


def _safe_message(value: Any) -> str:
    text = str(value) or "helper failure"
    text = "".join(ch if ord(ch) >= 32 and ord(ch) != 127 else " " for ch in text)
    return text[:MAX_TEXT_LENGTH] or "helper failure"


def _emit(payload: dict[str, Any]) -> None:
    try:
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
    except (TypeError, ValueError) as exc:
        encoded = json.dumps({
            "protocol": RESPONSE_PROTOCOL,
            "ok": False,
            "error": {
                "code": "OUTPUT_INVALID",
                "message": _safe_message(exc),
            },
        }, separators=(",", ":"))
    sys.stdout.write(encoded + "\n")


def main() -> int:
    try:
        request = _load_request()
        helper_path = Path(__file__).resolve(strict=True)
        _verify_exact_file(helper_path, request["helper_artifact"], helper=True)

        staging_root = Path.cwd().resolve(strict=True)
        verify_staged_source_closure(request["source_bundle"], staging_root)

        try:
            import mujoco  # type: ignore[import-not-found]
        except Exception as exc:
            raise HelperError("MUJOCO_UNAVAILABLE", "approved MuJoCo runtime is unavailable") from exc

        version = str(getattr(mujoco, "__version__", ""))
        if version != SUPPORTED_MUJOCO_VERSION:
            raise HelperError(
                "MUJOCO_VERSION_MISMATCH",
                f"MuJoCo version must be {SUPPORTED_MUJOCO_VERSION}, got {version or 'unknown'}",
            )

        root_path = staging_root.joinpath(*request["source_bundle"]["root"]["path"].split("/"))
        try:
            model = mujoco.MjModel.from_xml_path(str(root_path))
        except Exception as exc:
            raise HelperError("MODEL_COMPILE_FAILED", "MuJoCo model compilation failed") from exc

        # Re-bind the exact staged bytes after compilation. T16 must provide a
        # read-only staging mount; this second pass makes any observed drift
        # fail closed instead of attaching M2 facts to stale pre-compile hashes.
        verify_staged_source_closure(request["source_bundle"], staging_root)

        effective_model = extract_effective_model(
            model,
            mujoco,
            source_bundle=request["source_bundle"],
            helper_artifact=request["helper_artifact"],
            version=version,
        )
        _emit({
            "protocol": RESPONSE_PROTOCOL,
            "ok": True,
            "effective_model": effective_model,
        })
        return 0
    except HelperError as exc:
        _emit({
            "protocol": RESPONSE_PROTOCOL,
            "ok": False,
            "error": {"code": exc.code, "message": _safe_message(exc)},
        })
        return 1
    except Exception:
        _emit({
            "protocol": RESPONSE_PROTOCOL,
            "ok": False,
            "error": {
                "code": "HELPER_INTERNAL_ERROR",
                "message": "MuJoCo helper failed closed",
            },
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
