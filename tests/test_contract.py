"""Contratos do servidor local do Rune. Sem rede, sem bancos reais, stdlib only."""

from __future__ import annotations

import json
import os
import plistlib
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import server  # noqa: E402


def _router_days() -> list[dict]:
    return [
        {"date": "2026-11-01", "tokens": 600, "cost": 0.6, "requests": 2, "cached": 200, "input": 400},
        {"date": "2026-11-02", "tokens": 900, "cost": 0.9, "requests": 3, "cached": 300, "input": 600},
    ]


def _router_stub() -> dict:
    return {
        "days": _router_days(),
        "hours": {},
        "today": {"tokens": 900, "cost": 0.9, "requests": 3, "cached": 300, "input": 600},
        "providers": [{"provider": "claude", "tokens": 900, "requests": 3, "cost": 0.9, "share": 100.0}],
        "models": [{"provider": "claude", "model": "sonnet", "tokens": 900, "cost": 0.9}],
        "recent": [],
        "errors": [],
        "slo": {"providers": [], "overall": {}, "window": "7d"},
    }


CATALOG = {
    "online": True,
    "latency_ms": 12.5,
    "total": 3,
    "owners": [{
        "key": "cc", "label": "Claude Code", "connection": "claude", "models": 3,
        "context": 200000, "vision": True, "tools": True, "reasoning": True,
        "free": False, "sample": ["sonnet", "haiku"],
    }],
    "combos": [],
}

ROUTES = [{
    "connection": "claude", "ok": True, "model": "sonnet", "ms": 210, "code": 200,
    "error": "", "checked_at": "2026-11-03T10:00:00-03:00",
    "last_ok": "2026-11-03T10:00:00-03:00", "last_ok_ms": 210, "last_ok_model": "sonnet",
}]

DATA_FIXTURE = {
    "connections": [{
        "provider": "claude", "name": "conta principal", "auth": "oauth", "active": True,
        "status": "active", "error": "falhou para neto@example.com com sk-abcdef123456",
    }],
    "keys": [{
        "name": "principal", "keyId": "abc123", "active": True, "restricted": True,
        "key": "sk-supersecret123",
    }],
    "projects": [],
    "suggestions": [],
    "router_settings": {"tunnelEnabled": True, "headroomEnabled": False},
    "quota": {},
}


class MaskingTests(unittest.TestCase):
    def test_masks_email_and_secret_patterns(self):
        out = server._clean("falhou para neto@example.com com sk-abcdef123456 e Bearer abcdefghijkl")
        self.assertNotIn("neto@example.com", out)
        self.assertNotIn("sk-abcdef123456", out)
        self.assertNotIn("abcdefghijkl", out)
        self.assertIn("•••", out)

    def test_collapses_whitespace_and_truncates(self):
        self.assertEqual(server._clean("  a\n\n b\tc  "), "a b c")
        self.assertEqual(len(server._clean("x" * 300)), 260)
        self.assertEqual(len(server._clean("x" * 300, 40)), 40)
        self.assertEqual(server._clean(None), "")
        self.assertEqual(server._clean(""), "")


class ErrorMessageTests(unittest.TestCase):
    def test_reads_nested_payloads(self):
        self.assertEqual(server._error_message('{"error":{"message":"quota"}}'), "quota")
        self.assertEqual(server._error_message({"errors": [{"detail": "limite"}]}), "limite")
        self.assertEqual(server._error_message([{"title": "sem acesso"}]), "sem acesso")
        self.assertEqual(server._error_message({"unknown": 1}), "")

    def test_empty_and_too_deep(self):
        self.assertEqual(server._error_message(None), "")
        self.assertEqual(server._error_message('"texto solto"'), "texto solto")
        self.assertEqual(server._error_message({"message": {"message": {"message": "ok"}}}), "ok")


class OriginTests(unittest.TestCase):
    def test_accepts_local_and_headerless_clients(self):
        self.assertTrue(server._origin_matches("", "127.0.0.1:8770"))
        self.assertTrue(server._origin_matches("http://127.0.0.1:8770", "127.0.0.1:8770"))
        self.assertTrue(server._origin_matches("https://localhost", "localhost:8770"))
        self.assertTrue(server._origin_matches("http://[::1]:8770", "[::1]:8770"))

    def test_rejects_foreign_or_malformed_origins(self):
        self.assertFalse(server._origin_matches("https://evil.example", "127.0.0.1:8770"))
        self.assertFalse(server._origin_matches("http://127.0.0.1.evil.example", "127.0.0.1:8770"))
        self.assertFalse(server._origin_matches("http://[::1", "127.0.0.1:8770"))
        self.assertFalse(server._origin_matches("null", "127.0.0.1:8770"))
        self.assertFalse(server._origin_matches("file:///tmp/x", "127.0.0.1:8770"))


class NormalizeQuotaTests(unittest.TestCase):
    def test_computes_free_ratio_for_codex_and_claude(self):
        quota = server.normalize_quota({
            "quota": {
                "codex": {
                    "available": True,
                    "plan": "pro",
                    "primary": {"used_percent": 40, "reset_at": "18:00", "reset_after_seconds": 7200},
                    "weekly": {"used_percent": 25, "reset_at": "2026-11-09", "days_left": 5.5},
                    "budget": {"pace_percent_per_day": 3, "daily_target_percent": 4, "alert_percent": 80},
                },
                "claude": {
                    "available": True,
                    "raw": {
                        "five_hour": {"utilization": 50},
                        "seven_day": {"utilization": 20},
                    },
                },
                "google": {"available": False, "error": "sem login em eu@example.com"},
            }
        })
        self.assertEqual(quota["codex"]["session_free"], 60.0)
        self.assertEqual(quota["codex"]["session_hours"], 2.0)
        self.assertEqual(quota["codex"]["week_free"], 75.0)
        self.assertEqual(quota["codex"]["week_days"], 5.5)
        self.assertEqual(quota["claude"]["session_free"], 50.0)
        self.assertEqual(quota["claude"]["week_free"], 80.0)
        self.assertFalse(quota["google"]["available"])
        self.assertNotIn("eu@example.com", quota["google"]["error"])

    def test_missing_quota_marks_everything_unavailable(self):
        quota = server.normalize_quota({})
        for key in ("codex", "claude", "google"):
            self.assertFalse(quota[key]["available"])
        self.assertEqual(quota["google"]["error"], "sem medição de cota")


class SnapshotContractTests(unittest.TestCase):
    def _snapshot(self, tmp: Path) -> dict:
        with mock.patch.object(server, "_read_json", return_value=DATA_FIXTURE), \
                mock.patch.object(server, "load_router_usage", return_value=_router_stub()), \
                mock.patch.object(server, "load_qoder", return_value={"sessions": []}), \
                mock.patch.object(server, "router_catalog", return_value=CATALOG), \
                mock.patch.object(server, "fleet_routes", return_value=ROUTES), \
                mock.patch.object(server, "ROUTER_DB", tmp / "router.sqlite"), \
                mock.patch.object(server, "DATA_FILE", tmp / "data.json"), \
                mock.patch.object(server, "QODER_DB", tmp / "qoder.sqlite"):
            return server.build_snapshot()

    def test_snapshot_shape_and_totals(self):
        with tempfile.TemporaryDirectory() as raw:
            snap = self._snapshot(Path(raw))
        for key in ("meta", "series", "totals", "today", "providers", "models", "slo", "recent",
                    "errors", "alerts", "connections", "fleet", "keys", "quota", "sunStates",
                    "router", "projects", "suggestions", "inventory", "qoder", "insights"):
            self.assertIn(key, snap)
        self.assertEqual(snap["totals"]["tokens"], 1500)
        self.assertEqual(snap["totals"]["requests"], 5)
        self.assertEqual(snap["totals"]["cacheHit"], 50.0)
        self.assertEqual(snap["meta"]["sources"][0]["status"], "missing")
        self.assertEqual(len(snap["meta"]["privacy"]), 4)

    def test_fleet_shape_feeds_connection_capabilities(self):
        with tempfile.TemporaryDirectory() as raw:
            snap = self._snapshot(Path(raw))
        self.assertEqual(snap["fleet"]["routes"], ROUTES)
        self.assertEqual(snap["fleet"]["total"], 3)
        conn = snap["connections"][0]
        self.assertEqual(conn["owner"], "cc")
        self.assertEqual(conn["models"], 3)
        self.assertEqual(conn["context"], 200000)
        self.assertEqual(conn["capabilities"], {"vision": True, "tools": True, "reasoning": True})
        self.assertFalse(conn["free"])

    def test_snapshot_never_leaks_secrets(self):
        with tempfile.TemporaryDirectory() as raw:
            snap = self._snapshot(Path(raw))
        blob = json.dumps(snap, ensure_ascii=False)
        self.assertNotIn("sk-supersecret123", blob)
        self.assertNotIn("neto@example.com", blob)
        self.assertEqual(snap["keys"], [{"name": "principal", "keyId": "abc123", "active": True, "restricted": True}])


class SecurityAuditTests(unittest.TestCase):
    def test_audit_shape_and_score(self):
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            with mock.patch.object(server, "_read_json", return_value=DATA_FIXTURE), \
                    mock.patch.object(server, "HOST", "127.0.0.1"), \
                    mock.patch.object(server, "PORT", 8770), \
                    mock.patch.object(server, "DATA_FILE", tmp / "data.json"), \
                    mock.patch.object(server, "AI_USAGE", tmp / "ai-usage"), \
                    mock.patch.object(server, "ROUTER_DB", tmp / "router.sqlite"), \
                    mock.patch.object(server, "QODER_DB", tmp / "qoder.sqlite"):
                audit = server.security_audit()
        self.assertTrue(audit["ok"])
        self.assertIn(audit["level"], ("ok", "warn", "bad"))
        self.assertGreaterEqual(audit["score"], 0)
        self.assertLessEqual(audit["score"], 100)
        keys = [c["key"] for c in audit["checks"]]
        for key in ("bind", "perms", "secrets", "tunnel", "readonly", "mask", "redact"):
            self.assertIn(key, keys)
        for check in audit["checks"]:
            self.assertEqual(set(check), {"key", "label", "ok", "detail", "params"})
        self.assertEqual([f["code"] for f in audit["findings"]], ["tunnel_info"])
        self.assertEqual(audit["score"], 97)
        self.assertNotIn("sk-supersecret123", json.dumps(audit))

    def test_exposed_bind_is_a_finding(self):
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            with mock.patch.object(server, "_read_json", return_value={"keys": [], "router_settings": {}}), \
                    mock.patch.object(server, "HOST", "0.0.0.0"), \
                    mock.patch.object(server, "PORT", 8770), \
                    mock.patch.object(server, "DATA_FILE", tmp / "data.json"), \
                    mock.patch.object(server, "AI_USAGE", tmp / "ai-usage"), \
                    mock.patch.object(server, "ROUTER_DB", tmp / "router.sqlite"), \
                    mock.patch.object(server, "QODER_DB", tmp / "qoder.sqlite"):
                audit = server.security_audit()
        codes = [f["code"] for f in audit["findings"]]
        self.assertIn("bind_exposed", codes)
        self.assertEqual(audit["level"], "warn")


class MetricsTests(unittest.TestCase):
    SNAP = {
        "today": {"tokens": 10, "requests": 2, "cost": 0.25},
        "totals": {"cacheHit": 50.0},
        "meta": {"router_age": 5},
        "quota": {
            "codex": {"available": True, "week_free": 40.0, "session_free": 80.0},
            "claude": {"available": False},
        },
        "slo": {"providers": [{"provider": "claude", "requests": 3, "p50": 100, "p95": 300,
                               "ttftP50": 20, "errorRate": 0.0}]},
        "providers": [{"provider": 'a"b', "tokens": 5, "requests": 1, "cost": 0.1, "share": 100.0}],
        "models": [{"provider": "x", "model": "m", "tokens": 5}],
        "errors": [],
    }

    def test_metrics_include_contract_names(self):
        with mock.patch.object(server, "build_snapshot", return_value=self.SNAP):
            body = server.prometheus_metrics()
        self.assertTrue(body.endswith("\n"))
        for line in (
            "rune_up 1",
            "rune_tokens_today 10",
            "rune_requests_today 2",
            "rune_cost_today_usd 0.25",
            "rune_cache_hit_ratio 0.5",
            "rune_errors_open 0",
            "rune_router_age_seconds 5",
            'rune_provider_tokens{provider="a\\"b"} 5',
            'rune_provider_p95_latency_ms{provider="claude"} 300',
            'rune_provider_error_ratio{provider="claude"} 0.0',
            'rune_model_tokens{provider="x",model="m"} 5',
            "rune_codex_week_free_ratio 0.4",
            "rune_codex_session_free_ratio 0.8",
        ):
            self.assertIn(line, body)
        self.assertNotIn("rune_claude_week_free_ratio", body)

    def test_escape_label(self):
        self.assertEqual(server._escape_label('a"b\\c\nd'), 'a\\"b\\\\c d')

    def test_metrics_body_is_cached(self):
        with mock.patch.object(server, "_metrics_cache", {"at": 0.0, "body": ""}), \
                mock.patch.object(server, "METRICS_TTL", 60.0), \
                mock.patch.object(server, "prometheus_metrics", return_value="rune_up 1\n") as build:
            first = server.metrics_body()
            second = server.metrics_body()
        self.assertEqual(first, second)
        self.assertEqual(build.call_count, 1)


class FleetPersistenceTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.dir = self.tmp / "rune-data"
        patches = [
            mock.patch.object(server, "RUNE_DATA", self.dir),
            mock.patch.object(server, "FLEET_FILE", self.dir / "fleet.json"),
            mock.patch.object(server, "_fleet_state", {}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_persists_private_file_and_keeps_last_success(self):
        server._record_probe({"connection": "cc", "ok": True, "model": "sonnet", "ms": 123,
                              "code": 200, "error": ""})
        server._record_probe({"connection": "ag", "ok": True, "model": "gemini", "ms": 90,
                              "code": 200, "error": ""})
        first = server._load_fleet_state()
        self.assertTrue(first["cc"]["ok"])
        self.assertEqual(first["cc"]["last_ok_model"], "sonnet")

        server._record_probe({"connection": "cc", "ok": False, "model": "sonnet", "ms": None,
                              "code": 429, "error": "sem créditos para foo@bar.com sk-abcdef1"})
        row = server._load_fleet_state()["cc"]
        self.assertFalse(row["ok"])
        self.assertEqual(row["code"], 429)
        self.assertEqual(row["last_ok"], first["cc"]["last_ok"])
        self.assertEqual(row["last_ok_ms"], 123)
        self.assertNotIn("foo@bar.com", row["error"])
        self.assertNotIn("sk-", row["error"])

        self.assertEqual(os.stat(self.dir).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(self.dir / "fleet.json").st_mode & 0o777, 0o600)
        payload = json.loads((self.dir / "fleet.json").read_text(encoding="utf-8"))
        self.assertEqual(payload["version"], 1)
        self.assertEqual(set(payload["routes"]), {"cc", "ag"})

        self.assertEqual([r["connection"] for r in server.fleet_routes()], ["ag", "cc"])
        failed = server.fleet_routes()[1]
        self.assertFalse(failed["ok"])

    def test_corrupt_file_is_ignored(self):
        self.dir.mkdir(parents=True)
        (self.dir / "fleet.json").write_text("{not json", encoding="utf-8")
        with mock.patch.object(server, "FLEET_FILE", self.dir / "fleet.json"):
            self.assertEqual(server._load_fleet_state(), {})


class InstallerTests(unittest.TestCase):
    def _run(self, *args, **env_overrides):
        env = {
            **os.environ,
            "RUNE_PYTHON": sys.executable,
            "RUNE_PORT": "8899",
            **env_overrides,
        }
        return subprocess.run(["bash", str(ROOT / "install.sh"), *args],
                              capture_output=True, text=True, env=env)

    def test_print_plist_is_a_valid_launchd_job(self):
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            proc = self._run("--print-plist", HOME=raw,
                             AI_USAGE_HOME=str(home / "ai-usage"),
                             RUNE_LOGS=str(home / "logs"))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            plist = plistlib.loads(proc.stdout.encode("utf-8"))
        self.assertEqual(plist["Label"], "com.netorojas.rune")
        self.assertEqual(plist["ProgramArguments"], [sys.executable, str(ROOT / "server.py")])
        self.assertEqual(plist["WorkingDirectory"], str(ROOT))
        self.assertEqual(plist["EnvironmentVariables"]["RUNE_PORT"], "8899")
        self.assertEqual(plist["EnvironmentVariables"]["AI_USAGE_HOME"], str(home / "ai-usage"))
        self.assertEqual(plist["EnvironmentVariables"]["RUNE_NO_OPEN"], "1")
        self.assertTrue(plist["RunAtLoad"])
        self.assertIs(plist["KeepAlive"], True)
        self.assertEqual(plist["StandardOutPath"], str(home / "logs" / "rune.out.log"))

    def test_rejects_invalid_port(self):
        proc = self._run("--print-plist", RUNE_PORT="abc")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("RUNE_PORT", proc.stderr)

    def test_help_documents_the_three_actions(self):
        proc = self._run("--help")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        for flag in ("--print-plist", "--uninstall"):
            self.assertIn(flag, proc.stdout)


class IndexWiringTests(unittest.TestCase):
    def test_assets_and_dock_ids_exist(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        for asset in ("app.js", "i18n.js", "styles.css"):
            self.assertIn(asset, html)
        for ref in re.findall(r'(?:src|href)="([^"#][^"]*)"', html):
            if ref.startswith(("http://", "https://", "mailto:", "data:")):
                continue
            rel = ref.split("?")[0].lstrip("/")
            self.assertTrue((ROOT / rel).exists(), f"asset ausente: {ref}")
        for element_id in ("dockRoutes", "dockRoutesLabel", "dockRoutesSub"):
            self.assertIn(f'id="{element_id}"', html)


if __name__ == "__main__":
    unittest.main()
