#!/usr/bin/env python3
"""Verify generated T00 packets for byte integrity, not reviewer authenticity."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

def refuse(msg):
    raise ValueError("T00_CONVEYOR_VERIFY_REJECTED: " + msg)

def load(root, name):
    file = root / name
    if file.is_symlink() or not file.is_file():
        refuse("missing or symlink: " + name)
    return file.read_bytes()

def verify(root):
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        refuse("absolute result directory required")
    h = lambda s: hashlib.sha256(s).hexdigest()
    document = json.loads(load(root, "triage.json"))
    receipt = json.loads(load(root, "receipt.json"))
    index = json.loads(load(root, "work-packet-index.json"))
    if document.get("schema") != "t00.met-conveyor/1" or receipt.get("schema") != "t00.met-conveyor-receipt/1":
        refuse("wrong report schema")
    if h(load(root, "triage.json")) != receipt.get("triage_sha256") or h(load(root, "brief.md")) != receipt.get("brief_sha256"):
        refuse("report digest mismatch")
    if h(load(root, "work-packet-index.json")) != receipt.get("packet_index_sha256"):
        refuse("packet index digest mismatch")
    authority = document.get("authority", {})
    if any(authority.get(k) != receipt.get(k) for k in ("plan_sha256", "audit_sha256")):
        refuse("source digest mismatch")
    counts = authority.get("official_counts", {})
    expected_status_keys = {"MET", "PARTIAL", "NOT_MET", "NOT_CHECKED"}
    if not isinstance(counts, dict) or set(counts) != expected_status_keys or any(
            type(counts[k]) is not int or counts[k] < 0 for k in expected_status_keys):
        refuse("unreconciled official counts")
    if (sum(counts.values()) != 291 or receipt.get("official_MET") != counts["MET"]
            or receipt.get("official_delta") != 0
            or authority.get("official_MET_delta") != 0
            or not receipt.get("not_an_adjudication")):
        refuse("MET authority spoofed")
    policy = document.get("policy", {})
    if (not isinstance(policy, dict)
            or policy.get("mode") != "READ_ONLY_TRIAGE"
            or policy.get("auto_promote_MET") is not False
            or policy.get("release_activation") is not False
            or policy.get("evidence_is_unverified") is not True
            or authority.get("authenticated_external_verdict") is not False
            or document.get("official_audit_unchanged") is not True):
        refuse("false reviewer, release or MET authority")
    packets = index.get("packets")
    if index.get("schema") != "t00.met-work-packet-index/1" or not isinstance(packets, list) or len(packets) != receipt.get("packets_generated"):
        refuse("invalid packet index")
    if index.get("plan_sha256") != receipt.get("plan_sha256") or index.get("audit_sha256") != receipt.get("audit_sha256") or index.get("every_packet_is_unapproved") is not True:
        refuse("packet index source identity mismatch")
    seen = set()
    for row in packets:
        ident = row.get("task_id")
        if not isinstance(ident, str) or not re.fullmatch(r"[A-Za-z0-9-]+", ident) or ident in seen:
            refuse("bad or repeated packet id")
        seen.add(ident)
        name = "work-packets/" + ident + ".json"
        if row.get("path") != name or h(load(root, name)) != row.get("sha256"):
            refuse("packet bytes mismatch")
        packet = json.loads(load(root, name))
        expected_packet_fields = {
            "schema", "task_id", "source", "current_official_verdict",
            "current_official_gap", "current_official_evidence",
            "dependencies_not_met", "dependency_ready", "deliverables",
            "mandatory_tests", "acceptance", "write_scope", "proof_slots",
            "recorded_evidence_authenticated", "candidate_only_no_MET_granted",
        }
        if (not isinstance(packet, dict) or set(packet) != expected_packet_fields
                or packet.get("schema") != "t00.met-evidence-request/1"
                or packet.get("task_id") != ident
                or packet.get("current_official_verdict") not in ("PARTIAL", "NOT_MET", "NOT_CHECKED")
                or packet.get("candidate_only_no_MET_granted") is not True
                or not all(isinstance(packet.get(k), str) for k in
                           ("current_official_gap", "current_official_evidence"))
                or any(not isinstance(packet.get(k), list) or not all(
                    isinstance(v, str) for v in packet[k])
                    for k in ("dependencies_not_met", "deliverables",
                              "mandatory_tests", "acceptance", "write_scope"))
                or packet.get("dependency_ready") is not (len(packet["dependencies_not_met"]) == 0)
                or len(set(packet["dependencies_not_met"])) != len(packet["dependencies_not_met"])):
            refuse("missing, malformed or falsely adjudicated packet")
        packet_source = packet.get("source", {})
        if (not isinstance(packet_source, dict)
                or set(packet_source) != {"plan_sha256", "audit_sha256", "repository", "track"}
                or packet_source.get("plan_sha256") != receipt["plan_sha256"]
                or packet_source.get("audit_sha256") != receipt["audit_sha256"]
                or packet_source.get("repository") not in ("bskel", "becoder", "beval")
                or not isinstance(packet_source.get("track"), str)
                or not re.fullmatch(r"T[0-9]{2}", packet_source["track"])):
            refuse("packet source binding mismatch")
        slots = packet.get("proof_slots")
        REQUIRED_PROOF_SLOTS = {
            "main_merged_source_sha", "exact_head_ci_receipt_sha256",
            "normal_fixture_receipt_sha256", "adversarial_fixture_receipt_sha256",
            "packed_consumer_receipt_sha256", "runtime_oracle_receipt_sha256",
            "independent_reviewer_receipt_sha256", "t00_authorized_adjudication_sha256",
        }
        if packet.get("recorded_evidence_authenticated") is not False or not isinstance(slots, dict) or set(slots) != REQUIRED_PROOF_SLOTS or any(value is not None for value in slots.values()):
            refuse("unreviewed or missing proof slots")
    folder = root/"work-packets"
    if folder.is_symlink() or {x.name for x in folder.iterdir()} != {i + ".json" for i in seen}:
        refuse("unexpected packet contents")
    return {"valid": True, "scope": "INTEGRITY_ONLY", "MET": receipt["official_MET"], "MET_delta": 0, "packets": len(seen), "external_authority_verified": False}

if __name__ == "__main__":
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument("--directory", type=Path, required=True)
        args = parser.parse_args()
        print(json.dumps(verify(args.directory)))
    except (ValueError, OSError, KeyError, TypeError) as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)
