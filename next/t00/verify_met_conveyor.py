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
    if not isinstance(counts, dict) or any(type(counts.get(k)) is not int or counts[k] < 0
                                           for k in ("MET", "PARTIAL", "NOT_MET", "NOT_CHECKED")):
        refuse("unreconciled official counts")
    if (sum(counts.values()) != 291 or receipt.get("official_MET") != counts["MET"]
            or receipt.get("official_delta") != 0
            or authority.get("official_MET_delta") != 0
            or not receipt.get("not_an_adjudication")):
        refuse("MET authority spoofed")
    if document.get("policy", {}).get("auto_promote_MET") is not False:
        refuse("auto-promotion claimed")
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
        if packet.get("task_id") != ident or packet.get("current_official_verdict") == "MET" or not packet.get("candidate_only_no_MET_granted"):
            refuse("false completion claim")
        packet_source = packet.get("source", {})
        if not isinstance(packet_source, dict) or packet_source.get("plan_sha256") != receipt["plan_sha256"] or packet_source.get("audit_sha256") != receipt["audit_sha256"]:
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
