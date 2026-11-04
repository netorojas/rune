"""Contratos do servidor local do Rune. Sem rede, sem bancos reais, stdlib only."""

from __future__ import annotations

import json
import os
import plistlib
import re
import sqlite3
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
        for key in ("meta", "series", "month", "settings", "totals", "today", "providers", "models", "slo", "recent",
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


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name) / ".rune-data"
        patches = [
            mock.patch.object(server, "RUNE_DATA", self.dir),
            mock.patch.object(server, "SETTINGS_FILE", self.dir / "settings.json"),
            mock.patch.object(server, "NOTIFY_FILE", self.dir / "notify.json"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_normalizes_hostile_input(self):
        clean = server.normalize_settings({
            "budgets": {
                "global": -5,
                "threshold": 1234,
                "providers": {"Claude": 12.5, "bad key": 9, "codex": -1, "gemini": "abc"},
            },
            "alerts": {"macos": 0, "cooldown_min": 99999, "webhook": "http://evil.example/hook"},
        })
        self.assertIsNone(clean["budgets"]["global"])
        self.assertEqual(clean["budgets"]["threshold"], 80)
        self.assertEqual(clean["budgets"]["providers"], {"claude": 12.5})
        self.assertFalse(clean["alerts"]["macos"])
        self.assertEqual(clean["alerts"]["cooldown_min"], 1440)
        self.assertEqual(clean["alerts"]["webhook"], "")

    def test_accepts_https_and_loopback_webhooks(self):
        for url in ("https://hooks.example.com/T0KEN", "http://127.0.0.1:9000/hook", "http://localhost/hook"):
            self.assertEqual(server._webhook_url(url), url)
        for url in ("http://example.com/hook", "ftp://example.com", "javascript:alert(1)", "https://"):
            self.assertEqual(server._webhook_url(url), "")

    def test_round_trip_is_private_and_masks_the_webhook(self):
        saved = server.save_settings({
            "budgets": {"global": 50, "providers": {"codex": 20}, "threshold": 70},
            "alerts": {"macos": True, "webhook": "https://hooks.example.com/secret-token", "cooldown_min": 180},
        })
        self.assertEqual(saved["budgets"]["global"], 50.0)
        loaded = server.load_settings()
        self.assertEqual(loaded["budgets"]["providers"], {"codex": 20.0})
        self.assertEqual(os.stat(self.dir).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(self.dir / "settings.json").st_mode & 0o777, 0o600)

        view = server.public_settings()
        self.assertTrue(view["alerts"]["webhook_set"])
        self.assertEqual(view["alerts"]["webhook_host"], "hooks.example.com")
        self.assertNotIn("secret-token", json.dumps(view))


class BudgetAlertTests(unittest.TestCase):
    SETTINGS = {
        "budgets": {"global": 10.0, "providers": {"codex": 4.0, "claude": 5.0}, "threshold": 80},
        "alerts": {"macos": True, "webhook": "", "cooldown_min": 360},
    }
    MONTH = {"month": "2026-11", "cost": 9.0, "projected": 30.0, "byProvider": {"codex": 4.5, "claude": 1.0}}

    def test_flags_global_and_provider_over_threshold(self):
        rows = server.budget_alerts(self.MONTH, self.SETTINGS)
        self.assertEqual([r["budget"] for r in rows], ["global", "codex"])
        self.assertEqual(rows[0]["level"], "warn")
        self.assertEqual(rows[1]["level"], "over")
        self.assertEqual(rows[0]["tone"], "warn")
        self.assertEqual(rows[1]["pct"], 112.5)
        self.assertEqual(rows[0]["key"], "budget:global")

    def test_quiet_below_threshold_or_without_limits(self):
        month = {"month": "2026-11", "cost": 1.0, "projected": 3.0, "byProvider": {"codex": 0.5}}
        self.assertEqual(server.budget_alerts(month, self.SETTINGS), [])
        self.assertEqual(server.budget_alerts(month, server.normalize_settings({})), [])

    def test_due_alerts_respects_level_change_and_cooldown(self):
        now = server.datetime(2026, 11, 3, 12, 0, tzinfo=server.timezone.utc)
        alerts = [{"key": "budget:global", "level": "warn", "budget": "global"}]
        fresh = server.due_alerts(alerts, {}, now, 360)
        self.assertEqual(len(fresh), 1)

        recent = {"budget:global": {"level": "warn", "at": (now - server.timedelta(minutes=5)).isoformat()}}
        self.assertEqual(server.due_alerts(alerts, recent, now, 360), [])

        naive = {"budget:global": {"level": "warn", "at": now.astimezone().replace(tzinfo=None).isoformat()}}
        self.assertEqual(server.due_alerts(alerts, naive, now, 360), [])

        old = {"budget:global": {"level": "warn", "at": (now - server.timedelta(minutes=400)).isoformat()}}
        self.assertEqual(len(server.due_alerts(alerts, old, now, 360)), 1)

        escalated = [{"key": "budget:global", "level": "over", "budget": "global"}]
        self.assertEqual(len(server.due_alerts(escalated, recent, now, 360)), 1)

    def test_cycle_notifies_once_then_persists_the_state(self):
        now = server.datetime(2026, 11, 3, 12, 0, tzinfo=server.timezone.utc)
        written = {}

        def fake_write(path, payload):
            written[path.name] = payload

        with mock.patch.object(server, "load_settings", return_value=self.SETTINGS), \
                mock.patch.object(server, "load_router_usage", return_value={"month": self.MONTH}), \
                mock.patch.object(server, "_notify_state", return_value={}), \
                mock.patch.object(server, "_macos_notification") as mac, \
                mock.patch.object(server, "_write_private", side_effect=fake_write):
            first = server.alert_cycle(now=now)
            self.assertEqual(first["sent"], 2)
            self.assertEqual(mac.call_count, 2)
            self.assertIn("notify.json", written)
            self.assertEqual(written["notify.json"]["alerts"]["budget:codex"]["level"], "over")

            with mock.patch.object(server, "_notify_state", return_value=written["notify.json"]["alerts"]):
                second = server.alert_cycle(now=now)
        self.assertEqual(second["sent"], 0)

    def test_snapshot_stamps_budget_alerts_for_the_client(self):
        stub = {**_router_stub(), "month": {
            "month": "2026-11", "cost": 9.0, "projected": 30.0,
            "byProvider": {"claude": 9.0}, "elapsed": 3, "days_in_month": 30, "active_days": 3,
        }}
        settings = {
            "budgets": {"global": 10.0, "providers": {}, "threshold": 80},
            "alerts": {"macos": True, "webhook": "", "cooldown_min": 360},
        }
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            with mock.patch.object(server, "_read_json", return_value=DATA_FIXTURE), \
                    mock.patch.object(server, "load_router_usage", return_value=stub), \
                    mock.patch.object(server, "load_qoder", return_value={"sessions": []}), \
                    mock.patch.object(server, "router_catalog", return_value=CATALOG), \
                    mock.patch.object(server, "fleet_routes", return_value=ROUTES), \
                    mock.patch.object(server, "load_settings", return_value=settings), \
                    mock.patch.object(server, "ROUTER_DB", tmp / "router.sqlite"), \
                    mock.patch.object(server, "DATA_FILE", tmp / "data.json"), \
                    mock.patch.object(server, "QODER_DB", tmp / "qoder.sqlite"):
                snap = server.build_snapshot()
        self.assertEqual(snap["alerts"][0]["kind"], "budget")
        self.assertEqual(snap["alerts"][0]["level"], "warn")
        self.assertEqual(snap["month"]["cost"], 9.0)
        self.assertEqual(snap["settings"]["budgets"]["global"], 10.0)


class AccountingCsvTests(unittest.TestCase):
    def _router_db(self, directory: Path) -> Path:
        path = directory / "router.sqlite"
        conn = sqlite3.connect(path)
        conn.execute(
            "CREATE TABLE usageHistory (timestamp TEXT, provider TEXT, model TEXT, "
            "promptTokens INTEGER, completionTokens INTEGER, cost REAL)"
        )
        conn.executemany("INSERT INTO usageHistory VALUES (?,?,?,?,?,?)", [
            ("2026-11-02T10:00:00-03:00", "codex", "gpt-5", 100, 20, 0.25),
            ("2026-11-02T11:00:00-03:00", "codex", "gpt-5", 50, 10, 0.15),
            ("2026-11-03T09:00:00-03:00", "=cmd", "model,x", 10, 5, 0.1),
            ("2026-10-15T09:00:00-03:00", "codex", "gpt-5", 999, 999, 9.99),
        ])
        conn.commit()
        conn.close()
        return path

    def test_month_rows_are_aggregated_in_usd(self):
        with tempfile.TemporaryDirectory() as raw:
            db = self._router_db(Path(raw))
            with mock.patch.object(server, "ROUTER_DB", db):
                rows = server.month_accounting("2026-11")
                resolved, body = server.accounting_csv("2026-11")
        self.assertEqual(resolved, "2026-11")
        self.assertEqual(len(rows), 2)
        agg = next(r for r in rows if r["provider"] == "codex")
        self.assertEqual((agg["requests"], agg["input"], agg["output"], agg["tokens"]), (2, 150, 30, 180))
        self.assertAlmostEqual(agg["cost"], 0.4)
        self.assertNotIn("2026-10-15", body)
        self.assertIn("currency,cost_usd", body)
        self.assertIn("USD,0.400000", body)

    def test_formula_like_cells_are_neutralized(self):
        with tempfile.TemporaryDirectory() as raw:
            db = self._router_db(Path(raw))
            with mock.patch.object(server, "ROUTER_DB", db):
                _, body = server.accounting_csv("2026-11")
        self.assertIn("'=cmd", body)
        self.assertIn('"model,x"', body)
        self.assertEqual(server._csv_cell("@sum"), "'@sum")
        self.assertEqual(server._csv_cell("-1"), "'-1")
        self.assertEqual(server._csv_cell("codex"), "codex")

    def test_invalid_month_falls_back_to_current_and_empty_db_still_has_header(self):
        with tempfile.TemporaryDirectory() as raw:
            with mock.patch.object(server, "ROUTER_DB", Path(raw) / "missing.sqlite"):
                resolved, body = server.accounting_csv("2026-13")
        self.assertRegex(resolved, r"^\d{4}-(0[1-9]|1[0-2])$")
        self.assertEqual(body.count("\n"), 1)
        self.assertIn("date,provider,model", body)


class MonthTrendTests(unittest.TestCase):
    def test_twelve_months_fill_gaps_and_cut_older_history(self):
        with tempfile.TemporaryDirectory() as raw:
            db = Path(raw) / "router.sqlite"
            conn = sqlite3.connect(db)
            conn.execute("CREATE TABLE usageDaily (dateKey TEXT, data TEXT)")
            conn.execute(
                "CREATE TABLE usageHistory (timestamp TEXT, provider TEXT, model TEXT, "
                "promptTokens INTEGER, completionTokens INTEGER, cost REAL, status TEXT, tokens TEXT)"
            )
            conn.execute("CREATE TABLE requestDetails (timestamp TEXT, provider TEXT, model TEXT, status TEXT, data TEXT)")
            now = server.datetime.now().astimezone()

            def iso(months_ago: int) -> str:
                year, month = now.year, now.month - months_ago
                while month <= 0:
                    month += 12
                    year -= 1
                return server.datetime(year, month, 5, 12, 0, tzinfo=now.tzinfo).isoformat()

            conn.executemany("INSERT INTO usageHistory VALUES (?,?,?,?,?,?,?,?)", [
                (iso(0), "codex", "gpt-5", 100, 20, 0.5, "success", "{}"),
                (iso(1), "codex", "gpt-5", 100, 20, 0.25, "success", "{}"),
                (iso(11), "codex", "gpt-5", 50, 10, 0.1, "success", "{}"),
                (iso(12), "codex", "gpt-5", 50, 10, 9.0, "success", "{}"),
            ])
            conn.commit()
            conn.close()
            with mock.patch.object(server, "ROUTER_DB", db):
                usage = server.load_router_usage(days=2)
        months = usage["months"]
        self.assertEqual(len(months), 12)
        self.assertEqual(months[-1]["cost"], 0.5)
        self.assertEqual(months[-2]["cost"], 0.25)
        self.assertEqual(months[0]["cost"], 0.1)
        self.assertAlmostEqual(sum(m["cost"] for m in months), 0.85)
        self.assertEqual(months[-1]["label"], f"{now.month:02d}/{str(now.year)[2:]}")


class DynamicRouteTests(unittest.TestCase):
    def test_unknown_owner_becomes_a_probeable_route(self):
        catalog = {"online": True, "total": 1, "owners": [{
            "key": "novo", "label": "novo", "connection": "novo", "models": 1, "sample": ["novo/model"],
        }]}
        with mock.patch.object(server, "router_catalog", return_value=catalog), \
                mock.patch.dict(server._catalog_raw, {"by_owner": {"novo": ["novo/model"]}}, clear=False), \
                mock.patch.object(server, "probe_route", return_value={
                    "ok": True, "model": "novo/model", "ms": 12, "code": 200,
                }), \
                mock.patch.object(server, "_record_probe"):
            server._conn_cache.pop("novo", None)
            server._route_cache.pop("novo", None)
            result = server.probe_connection("novo")
            unknown = server.probe_connection("fantasma")
        self.assertTrue(result["ok"])
        self.assertEqual(result["owner"], "novo")
        self.assertEqual(result["model"], "novo/model")
        self.assertEqual(unknown["error"], "rota desconhecida")


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
