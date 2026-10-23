#!/usr/bin/env python3
"""Synthetic failure-gate tests for the T00 read-only conveyor."""
import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import met_conveyor as c
import verify_met_conveyor as verifier


def fixture():
    tasks = []
    for track in range(24):
        for phase in range(1, 7):
            tasks.append(dict(id="T%02d-%02d" % (track, phase), kind="core",
                              track="T%02d" % track, repository="bskel",
                              title="synthetic", depends_on=[], deliverables=["fixture"],
                              mandatory_tests=["negative"], acceptance=["no waiver"]))
    for family in range(49):
        for phase in range(1, 4):
            tasks.append(dict(id="HTTP-test%02d-%02d" % (family, phase),
                              kind="target", track="T11", repository="bskel",
                              title="synthetic", depends_on=[], deliverables=["fixture"],
                              mandatory_tests=["negative"], acceptance=["no waiver"]))
    count = 0
    for i in range(1, len(tasks)):
        for step in range(1, min(3, i) + 1):
            if count == 744:
                break
            tasks[i]["depends_on"].append(tasks[i-step]["id"])
            count += 1
    assert len(tasks) == 291 and count == 744
    rows = [dict(id=t["id"], track=t["track"], kind=t["kind"],
                 verdict="MET" if i < 92 else "PARTIAL" if i < 232 else "NOT_MET",
                 evidence="test only", gap="missing packaged fixture and evidence")
            for i, t in enumerate(tasks)]
    return (dict(schema=c.PLAN_SCHEMA, task_count=291, tasks=tasks),
            dict(schema=c.AUDIT_SCHEMA, counts=dict(MET=92, PARTIAL=140,
                NOT_MET=59, NOT_CHECKED=0), results=rows))


class ConveyorTests(unittest.TestCase):
    def test_triage_never_votes_met(self):
        plan, audit = fixture()
        report = c.analyze(plan, audit, "a"*64, "b"*64,
                           focus=["HTTP-test00", "HTTP-test01"])
        self.assertEqual(report["authority"]["direct_edges"], 744)
        self.assertEqual(report["counts"]["ready_dependencies"] +
                         report["counts"]["blocked_dependencies"], 199)
        self.assertEqual(report["authority"]["official_MET_delta"], 0)
        self.assertFalse(report["policy"]["auto_promote_MET"])
        self.assertFalse(report["policy"]["release_activation"])
        packets = c.task_packets(report, plan, audit)
        self.assertGreaterEqual(len(packets), 5)
        for packet in packets:
            self.assertNotEqual(packet["current_official_verdict"], "MET")
            self.assertFalse(packet["recorded_evidence_authenticated"])
            self.assertTrue(all(value is None for value in packet["proof_slots"].values()))

    def test_adversarial_rejection(self):
        plan, audit = fixture()
        changed = copy.deepcopy(audit)
        changed["results"][0]["verdict"] = "NOT_MET"
        with self.assertRaises(c.Reject):
            c.analyze(plan, changed, "a"*64, "b"*64)
        changed_plan = copy.deepcopy(plan)
        changed_plan["tasks"][200]["depends_on"][0] = changed_plan["tasks"][210]["id"]
        with self.assertRaises(c.Reject):
            c.analyze(changed_plan, audit, "a"*64, "b"*64)
        changed_plan = copy.deepcopy(plan)
        changed_plan["tasks"][200]["depends_on"][0] = "MISSING"
        with self.assertRaises(c.Reject):
            c.analyze(changed_plan, audit, "a"*64, "b"*64)

    def test_cli_pins_evidence_and_rejects_overwrite(self):
        plan, audit = fixture()
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            inputs = root/"inputs"
            inputs.mkdir()
            p, a = inputs/"plan.json", inputs/"audit.json"
            p.write_text(json.dumps(plan), encoding="utf8")
            a.write_text(json.dumps(audit), encoding="utf8")
            sha = lambda f: hashlib.sha256(f.read_bytes()).hexdigest()
            cli = [sys.executable, str(Path(c.__file__).resolve()),
                   "--plan", str(p), "--audit", str(a),
                   "--plan-sha256", sha(p), "--audit-sha256", sha(a),
                   "--focus", "HTTP-test00", "--out-dir", str(root/"out")]
            first = subprocess.run(cli, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            index = json.loads((root/"out/work-packet-index.json").read_text())
            receipt = json.loads((root/"out/receipt.json").read_text())
            self.assertEqual(receipt["packets_generated"], len(index["packets"]))
            self.assertEqual(receipt["official_delta"], 0)
            self.assertEqual(receipt["packet_index_sha256"],
                             sha(root/"out/work-packet-index.json"))
            good = verifier.verify(root/"out")
            self.assertTrue(good["valid"])
            self.assertEqual(good["MET_delta"], 0)
            self.assertFalse(good["external_authority_verified"])
            self.assertEqual(subprocess.run(cli, capture_output=True).returncode, 2)
            cli[cli.index("--audit-sha256")+1] = "0"*64
            cli[-1] = str(root/"invalid")
            self.assertEqual(subprocess.run(cli, capture_output=True).returncode, 2)
            self.assertFalse((root/"invalid").exists())
            f = root/"out/brief.md"
            f.write_text(f.read_text() + "edited", encoding="utf8")
            with self.assertRaises(ValueError):
                verifier.verify(root/"out")


if __name__ == "__main__":
    unittest.main()
