#!/usr/bin/env python3
"""Read-only T00 MET closure conveyor. Produces work packets, NEVER grants MET."""
import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import sys

PLAN_SCHEMA = "bskel.scale-backlog/1"
AUDIT_SCHEMA = "t00.task-audit/2"
SCHEMA = "t00.met-conveyor/1"
STATES = ("MET", "PARTIAL", "NOT_MET", "NOT_CHECKED")
FOCUS = ("HTTP-java-spring", "HTTP-python-fastapi", "ORM-prisma", "PROTO-websocket", "GAME-threejs")
SHA = re.compile(r"^[a-f0-9]{64}$")
TARGET_STAGE = re.compile(r"^(.*)-(01|02|03)$")
GAP_TAGS = {
    "product_wiring": r"wired|wiring|consumer|bridge|registry|packag|project|연결|투영|패키지|제품 경로|브리지|등록",
    "runtime_oracle": r"runtime|oracle|fixture|docker|real |실행|실런타임|재현|검증 환경",
    "independent_review": r"independent|certificate|attestation|sign|review|독립|서명|인증|승인",
    "source_provenance": r"sha256|sha-256|exact|version|commit|hash|evidence|receipt|artifact|증거|영수증|고정|pin",
    "release_governance": r"release|rollback|policy|owner|gate|lease|승격|릴리스|롤백|권한|강제",
    "missing_implementation": r"not implemented|absent|missing|부재|미구현|없음|누락|구현 자체",
}


class Reject(Exception):
    pass


def check(ok, code, detail):
    if not ok:
        raise Reject("T00_CONVEYOR_REJECTED " + code + ": " + detail)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_plan(plan, total=291, edges=744):
    check(isinstance(plan, dict) and plan.get("schema") == PLAN_SCHEMA,
          "PLAN_SCHEMA", "unrecognized plan")
    tasks = plan.get("tasks")
    check(isinstance(tasks, list) and len(tasks) == total
          and plan.get("task_count") == total, "PLAN_COUNT", "expected pinned task count")
    by = {}
    rev = collections.defaultdict(list)
    degree = {}
    counts = collections.Counter()
    for t in tasks:
        check(isinstance(t, dict) and isinstance(t.get("id"), str)
              and re.fullmatch(r"[A-Za-z0-9-]+", t["id"]) is not None
              and t["id"] not in by
              and t.get("kind") in ("core", "target")
              and t.get("repository") in ("bskel", "becoder", "beval")
              and isinstance(t.get("track"), str)
              and all(isinstance(t.get(k), list) for k in
                      ("depends_on", "deliverables", "acceptance", "mandatory_tests")),
              "PLAN_SHAPE", "malformed, duplicated or missing task")
        by[t["id"]] = t
        degree[t["id"]] = 0
        counts[t["kind"]] += 1
    n_edges = 0
    for t in tasks:
        refs = t["depends_on"]
        check(len(set(refs)) == len(refs), "PLAN_DUP_DEP", t["id"])
        for dep in refs:
            check(dep in by and dep != t["id"], "PLAN_BAD_DEP", t["id"] + " -> " + str(dep))
            rev[dep].append(t["id"])
            degree[t["id"]] += 1
            n_edges += 1
    check(n_edges == edges, "PLAN_EDGES", "expected %d; found %d" % (edges, n_edges))
    if total == 291:
        check(counts["core"] == 144 and counts["target"] == 147,
              "PLAN_KINDS", "expected 144 core + 147 target tasks")
    queue = collections.deque(t for t, n in degree.items() if n == 0)
    seen = 0
    while queue:
        current = queue.popleft()
        seen += 1
        for next_id in rev[current]:
            degree[next_id] -= 1
            if degree[next_id] == 0:
                queue.append(next_id)
    check(seen == total, "PLAN_CYCLE", "dependency cycle")
    return by, rev, n_edges, counts


def validate_audit(audit, by_plan, total=291):
    check(isinstance(audit, dict) and audit.get("schema") == AUDIT_SCHEMA,
          "AUDIT_SCHEMA", "not a T00 task audit")
    counts = audit.get("counts")
    rows = audit.get("results")
    check(isinstance(counts, dict) and isinstance(rows, list)
          and len(rows) == total and all(type(counts.get(k)) is int
          and counts[k] >= 0 for k in STATES)
          and sum(counts[k] for k in STATES) == total, "AUDIT_COUNT", "unreconciled counts")
    by, observed = {}, collections.Counter()
    for row in rows:
        check(isinstance(row, dict) and isinstance(row.get("id"), str)
              and row["id"] in by_plan and row["id"] not in by
              and row.get("kind") == by_plan[row["id"]]["kind"]
              and row.get("track") == by_plan[row["id"]]["track"]
              and row.get("verdict") in STATES
              and isinstance(row.get("gap"), str)
              and isinstance(row.get("evidence"), str),
              "AUDIT_ROW", "id or verdict identity mismatch")
        by[row["id"]] = row
        observed[row["verdict"]] += 1
    check(set(by) == set(by_plan) and
          all(observed[s] == counts[s] for s in STATES),
          "AUDIT_COUNTS_MISMATCH", "actual row counts differ from reported")
    return by


def classify_gap(gap):
    return [k for k, pattern in GAP_TAGS.items()
            if re.search(pattern, gap, re.IGNORECASE)]


def analyze(plan, audit, plan_sha, audit_sha, *, total=291, edges=744, focus=FOCUS, max_items=5):
    check(bool(SHA.fullmatch(plan_sha)) and bool(SHA.fullmatch(audit_sha)),
          "SOURCE_PIN", "exact plan and audit SHA256 required")
    check(type(max_items) is int and 1 <= max_items <= 25, "MAX", "range 1..25")
    p, reverse, n_edges, kinds = validate_plan(plan, total, edges)
    by = validate_audit(audit, p, total)
    tasks = {}
    for id, t in p.items():
        row = by[id]
        dep = sorted(d for d in t["depends_on"] if by[d]["verdict"] != "MET")
        downstream = sorted(d for d in reverse[id] if by[d]["verdict"] != "MET")
        phase = id.rsplit("-", 1)[-1]
        is_open = row["verdict"] != "MET"
        score = (35 if row["verdict"] == "PARTIAL" else 12) \
            + (25 if not dep else 0) + min(25, len(downstream)*3) \
            + (12 if t["kind"] == "target" and phase == "01" else 0) \
            + (9 if phase in ("05", "06") else 0) - min(18, len(dep)*3)
        tasks[id] = {
            "id": id, "track": t["track"], "kind": t["kind"],
            "repository": t["repository"], "title": t["title"],
            "phase": phase, "verdict": row["verdict"], "score": score if is_open else 0,
            "score_is_heuristic": True,
            "blocked_by_unmet_dependency": dep, "direct_downstream_open": downstream,
            "dependency_clear": not dep, "gap_tags_heuristic": classify_gap(row["gap"]),
            "gap_verbatim": row["gap"], "evidence_verbatim": row["evidence"],
            "mandatory_tests": t["mandatory_tests"], "acceptance": t["acceptance"],
            "deliverables": t["deliverables"], "write_scope": t.get("write_scope", []),
            "ready_for_independent_adjudication": False,
            "met_promoted_by_tool": False,
        }
    open_rows = [r for r in tasks.values() if r["verdict"] != "MET"]
    ready = sorted((r for r in open_rows if r["dependency_clear"]),
                   key=lambda r: (-r["score"], r["id"]))
    fanout = sorted((r for r in open_rows if r["direct_downstream_open"]),
                    key=lambda r: (-len(r["direct_downstream_open"]), r["id"]))

    def phases(kind, count):
        result = {}
        for n in range(1, count + 1):
            phase = "%02d" % n
            sub = [v for v in tasks.values() if v["kind"] == kind and v["phase"] == phase]
            result[phase] = dict(collections.Counter(v["verdict"] for v in sub))
            for name in STATES:
                result[phase].setdefault(name, 0)
            result[phase]["total"] = len(sub)
        return result

    target_families = {m.group(1) for t in p.values()
                       if t["kind"] == "target" for m in [TARGET_STAGE.fullmatch(t["id"])] if m}
    check(len(target_families) * 3 == kinds["target"], "TARGET_FAMILY", "target stages mismatch")
    check(isinstance(focus, (list, tuple)) and 1 <= len(focus) <= 10
          and len(set(focus)) == len(focus) and set(focus) <= target_families,
          "FOCUS", "invalid or duplicate target family")
    focus_packets = []
    for family in focus:
        stages = [tasks[family + "-" + s] for s in ("01", "02", "03")]
        next_open = next((v["id"] for v in stages if v["verdict"] != "MET"), None)
        focus_packets.append({
            "target": family, "next_unmet": next_open,
            "stages": [{k: item[k] for k in ("id", "verdict", "dependency_clear",
                       "blocked_by_unmet_dependency", "gap_verbatim",
                       "mandatory_tests", "acceptance")} for item in stages],
        })
    policy = {
        "mode": "READ_ONLY_TRIAGE", "auto_promote_MET": False, "release_activation": False,
        "evidence_is_unverified": True,
        "fast_ci": "focused tests for developer feedback only",
        "full_ci": "source-bound merged HEAD + cross-repo + VM signer + rollback + independent review",
        "completion_checklist": [
            "Main-merged exact source tree independently checked",
            "Normal + adversarial fixture and command/exit/log SHA receipts",
            "Actual packed consumer and real runtime/oracle scoped to task",
            "Exact framework version and unsupported cases recorded",
            "Exact-head all-required CI green with no masked or waived gates",
            "Independent reviewer/owner authenticates immutable receipts and lease",
            "T00 authorized read-only independent adjudication followed by CAS approval",
        ],
    }
    return {
        "schema": SCHEMA,
        "authority": {
            "audit_sha256": audit_sha, "plan_sha256": plan_sha,
            "basis_plan_bundle": audit.get("basis", {}).get("plan_bundle"),
            "official_counts": dict(audit["counts"]),
            "official_met_pct": round(100 * audit["counts"]["MET"]/total, 2),
            "tasks": total, "direct_edges": n_edges,
            "core": kinds["core"], "target": kinds["target"],
            "official_MET_delta": 0, "authenticated_external_verdict": False,
        },
        "policy": policy,
        "counts": {"open": len(open_rows), "ready_dependencies": len(ready),
                   "blocked_dependencies": len(open_rows)-len(ready)},
        "core_phases": phases("core", 6), "target_phases": phases("target", 3),
        "priority_queue": ready[:max_items], "fanout_queue": fanout[:max_items],
        "focus_packets": focus_packets,
        "gap_tag_counts": {tag: sum(tag in row["gap_tags_heuristic"] for row in open_rows)
                           for tag in GAP_TAGS},
        "official_audit_unchanged": True,
    }


def markdown(x):
    a = x["authority"]; c = a["official_counts"]
    lines = [
        "# T00 MET conveyor — read-only backlog and evidence gaps", "",
        "This document is a work queue, NOT an official MET adjudication.",
        "Audit SHA256: " + a["audit_sha256"],
        "Original plan backlog SHA256: " + a["plan_sha256"],
        "Plan: %d tasks, %d direct DAG edges" % (a["tasks"], a["direct_edges"]), "",
        "MET %d/%d (%.2f%%), PARTIAL %d, NOT_MET %d, NOT_CHECKED %d. MET delta: 0." %
        (c["MET"], a["tasks"], a["official_met_pct"], c["PARTIAL"], c["NOT_MET"], c["NOT_CHECKED"]),
        "Open with all direct dependencies MET: %d; with unmet dependencies: %d." %
        (x["counts"]["ready_dependencies"], x["counts"]["blocked_dependencies"]), "",
        "## Core task stages", "",
        "| Stage | MET | PARTIAL | NOT_MET |", "|---|---:|---:|---:|",
    ]
    for k,v in x["core_phases"].items():
        lines.append("| %s | %d/%d | %d | %d |" % (k,v["MET"],v["total"],v["PARTIAL"],v["NOT_MET"]))
    lines += ["", "## Target stages", "",
              "| Stage | MET | PARTIAL | NOT_MET |", "|---|---:|---:|---:|"]
    for k,v in x["target_phases"].items():
        lines.append("| %s | %d/%d | %d | %d |" % (k,v["MET"],v["total"],v["PARTIAL"],v["NOT_MET"]))
    lines += ["", "## Priority queue (suggestions only)", "",
              "| Task | Verdict | Downstream open | Gap categories |",
              "|---|---|---:|---|"]
    for r in x["priority_queue"]:
        lines.append("| %s | %s | %d | %s |" %
                     (r["id"],r["verdict"],len(r["direct_downstream_open"]),
                      ", ".join(r["gap_tags_heuristic"])))
    lines += ["", "## Five target work packets", ""]
    for f in x["focus_packets"]:
        lines.extend(["### "+f["target"], "Next non-MET: "+str(f["next_unmet"])])
        for t in f["stages"]:
            if t["verdict"] != "MET":
                lines.append("- %s %s; unmet prerequisites: %s; gap: %s" %
                    (t["id"],t["verdict"],", ".join(t["blocked_by_unmet_dependency"]) or "none",
                     t["gap_verbatim"].replace("|","/")))
        lines.append("")
    lines += ["## Official completion checklist (no automatic approvals)", ""]
    lines += ["- [ ] "+c for c in x["policy"]["completion_checklist"]]
    lines += ["", "No task status, audit file, production resource or branch was modified.", ""]
    return "\n".join(lines)



def task_packets(report, plan, audit):
    """Deterministic incomplete proof requests. These are NOT attestations."""
    by_plan = {t["id"]: t for t in plan["tasks"]}
    by_audit = {t["id"]: t for t in audit["results"]}
    candidates = [t["id"] for t in report["priority_queue"]]
    candidates.extend(f["next_unmet"] for f in report["focus_packets"] if f["next_unmet"])
    ids = list(dict.fromkeys(candidates))
    packets = []
    for task_id in ids:
        p, a = by_plan[task_id], by_audit[task_id]
        check(a["verdict"] != "MET", "PACKET_MET", task_id)
        deps = sorted(d for d in p["depends_on"] if by_audit[d]["verdict"] != "MET")
        packets.append({
            "schema": "t00.met-evidence-request/1",
            "task_id": task_id,
            "source": {
                "audit_sha256": report["authority"]["audit_sha256"],
                "plan_sha256": report["authority"]["plan_sha256"],
                "repository": p["repository"],
                "track": p["track"],
            },
            "current_official_verdict": a["verdict"],
            "current_official_gap": a["gap"],
            "current_official_evidence": a["evidence"],
            "dependencies_not_met": deps,
            "dependency_ready": len(deps) == 0,
            "deliverables": p["deliverables"],
            "mandatory_tests": p["mandatory_tests"],
            "acceptance": p["acceptance"],
            "write_scope": p.get("write_scope", []),
            "proof_slots": {
                "main_merged_source_sha": None,
                "exact_head_ci_receipt_sha256": None,
                "normal_fixture_receipt_sha256": None,
                "adversarial_fixture_receipt_sha256": None,
                "packed_consumer_receipt_sha256": None,
                "runtime_oracle_receipt_sha256": None,
                "independent_reviewer_receipt_sha256": None,
                "t00_authorized_adjudication_sha256": None,
            },
            "recorded_evidence_authenticated": False,
            "candidate_only_no_MET_granted": True,
        })
    return packets


def main(argv=None):
    p = argparse.ArgumentParser(description="Read-only source-pinned T00 MET conveyor")
    p.add_argument("--plan", required=True, type=Path)
    p.add_argument("--audit", required=True, type=Path)
    p.add_argument("--plan-sha256", required=True)
    p.add_argument("--audit-sha256", required=True)
    p.add_argument("--out-dir", required=True, type=Path)
    p.add_argument("--max", type=int, default=5)
    p.add_argument("--focus", default=",".join(FOCUS))
    args = p.parse_args(argv)
    for label, file, expected in (("plan", args.plan, args.plan_sha256),
                                  ("audit", args.audit, args.audit_sha256)):
        check(file.is_absolute() and file.is_file()
              and SHA.fullmatch(expected) is not None, "INPUT_PATH", label)
        check(digest(file.read_bytes()) == expected, "INPUT_SHA", label+" bytes differ")
    plan = json.loads(args.plan.read_bytes())
    audit = json.loads(args.audit.read_bytes())
    report = analyze(plan,audit,args.plan_sha256,args.audit_sha256,
                     max_items=args.max,focus=args.focus.split(","))
    out = args.out_dir
    check(out.is_absolute() and not out.exists() and out.parent.is_dir()
          and out.parent.resolve() not in (args.plan.parent.resolve(), args.audit.parent.resolve()),
          "OUTPUT_PATH", "need fresh directory separate from authority")
    out.mkdir(mode=0o700)
    payload = (json.dumps(report,ensure_ascii=False,indent=2)+"\n").encode("utf8")
    (out/"triage.json").open("xb").write(payload)
    (out/"brief.md").open("x",encoding="utf8").write(markdown(report))
    packets_dir = out/"work-packets"
    packets_dir.mkdir(mode=0o700)
    packet_records = []
    for packet in task_packets(report,plan,audit):
        packet_file = packets_dir/(packet["task_id"]+".json")
        packet_bytes = (json.dumps(packet,ensure_ascii=False,indent=2)+"\n").encode("utf8")
        packet_file.open("xb").write(packet_bytes)
        packet_file.chmod(0o600)
        packet_records.append({"task_id":packet["task_id"],
                               "sha256":digest(packet_bytes),
                               "path":"work-packets/"+packet_file.name})
    index = {"schema":"t00.met-work-packet-index/1",
             "audit_sha256":args.audit_sha256,
             "plan_sha256":args.plan_sha256,
             "packets":packet_records,
             "every_packet_is_unapproved":True}
    index_bytes = (json.dumps(index,ensure_ascii=False,indent=2)+"\n").encode("utf8")
    (out/"work-packet-index.json").open("xb").write(index_bytes)
    receipt = {"schema":"t00.met-conveyor-receipt/1","plan_sha256":args.plan_sha256,
        "audit_sha256":args.audit_sha256,"triage_sha256":digest(payload),
        "packet_index_sha256":digest(index_bytes),
        "packets_generated":len(packet_records),
        "official_MET":audit["counts"]["MET"],"official_delta":0,
        "not_an_adjudication":True}
    (out/"receipt.json").open("x",encoding="utf8").write(json.dumps(receipt,indent=2)+"\n")
    print(json.dumps({"state":"TRIAGED_NOT_MET","MET":audit["counts"]["MET"],
        "ready":report["counts"]["ready_dependencies"],
        "blocked":report["counts"]["blocked_dependencies"],"output":str(out)}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Reject, OSError, ValueError, TypeError) as exc:
        print(str(exc),file=sys.stderr)
        sys.exit(2)
