#!/usr/bin/env python3
"""Rune Live — protótipo local-first.

Lê apenas metadados locais (9router, Qoder Desktop, coletor ~/.ai-usage) em
modo somente-leitura. Nunca devolve chaves, access tokens ou conteúdo de
prompts. Escuta exclusivamente em 127.0.0.1.
"""
from __future__ import annotations

import calendar
import csv
import io
import json
import math
import os
import re
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib.parse import parse_qs, urlparse

BASE = Path(__file__).resolve().parent
ASSETS = BASE / "assets"
AI_USAGE = Path(os.environ.get("AI_USAGE_HOME") or (Path.home() / ".ai-usage")).expanduser()
DATA_FILE = AI_USAGE / "data.json"
COLLECT = AI_USAGE / "collect.py"
COLLECT_LOCAL = BASE / "collector" / "collect.py"
if not COLLECT.exists() and COLLECT_LOCAL.exists():
    COLLECT = COLLECT_LOCAL
ROUTER_DB = Path.home() / ".9router" / "db" / "data.sqlite"
RUNE_DATA = BASE / ".rune-data"
FLEET_FILE = RUNE_DATA / "fleet.json"
SETTINGS_FILE = RUNE_DATA / "settings.json"
NOTIFY_FILE = RUNE_DATA / "notify.json"
QODER_DB = Path.home() / "Library" / "Application Support" / "com.qoder.app.stable" / "main.sqlite"
HOST = os.environ.get("RUNE_HOST", "127.0.0.1")
PORT = int(os.environ.get("RUNE_PORT", "8770"))
ROUTER_URL = os.environ.get("RUNE_ROUTER_URL", "http://127.0.0.1:20128").rstrip("/")

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
SECRET_RE = re.compile(r"(sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{8,}|ya29\.[A-Za-z0-9._-]+|sk-ant-[A-Za-z0-9._-]+)")
_refresh_lock = threading.Lock()


def _ro(path: Path) -> sqlite3.Connection | None:
    if not path.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2.0)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error:
        return None


def _iso(ms: int | None) -> str | None:
    if not ms:
        return None
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone().isoformat()
    except (ValueError, OSError):
        return None


def _hhmm(raw: str | None) -> str:
    if not raw:
        return ""
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone().strftime("%H:%M")
    except ValueError:
        return raw[11:16]


def _clean(text: str | None, limit: int = 260) -> str:
    if not text:
        return ""
    s = EMAIL_RE.sub("•••@•••", str(text))
    s = SECRET_RE.sub("•••", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit]


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _tokens(prompt: int | float, completion: int | float) -> int:
    return int(prompt or 0) + int(completion or 0)


def _error_message(obj, depth: int = 0) -> str:
    if depth > 5 or obj is None:
        return ""
    if isinstance(obj, str):
        try:
            return _error_message(json.loads(obj), depth + 1)
        except ValueError:
            return obj.strip()
    if isinstance(obj, dict):
        for key in ("message", "detail", "title", "error"):
            if key in obj:
                msg = _error_message(obj[key], depth + 1)
                if msg:
                    return msg
        if isinstance(obj.get("errors"), list) and obj["errors"]:
            return _error_message(obj["errors"][0], depth + 1)
    if isinstance(obj, list) and obj:
        return _error_message(obj[0], depth + 1)
    return ""


def _pct(part: float, whole: float) -> float:
    return round(part / whole * 100, 1) if whole else 0.0


def _operator_name() -> str:
    env = (os.environ.get("RUNE_OPERATOR") or "").strip()
    if env:
        return env[:24]
    try:
        import pwd
        full = pwd.getpwuid(os.getuid()).pw_gecos.split(",")[0].strip()
        if full:
            return full.split()[0][:24]
    except (ImportError, KeyError, OSError):
        pass
    name = Path.home().name.lstrip(".")
    return name[:24] if name else "operador"


def _origin_matches(origin: str, host: str) -> bool:
    """Só aceita POST de uma origem que aponta para o próprio Host local (anti-CSRF)."""
    origin = (origin or "").strip()
    if not origin:
        return True  # curl e scripts locais não enviam Origin
    try:
        origin_host = (urlparse(origin).hostname or "").lower()
    except ValueError:
        return False
    req_host = (host or "").strip().lower()
    if req_host.startswith("["):
        req_host = req_host[1:].split("]", 1)[0]
    else:
        req_host = req_host.split(":")[0]
    return bool(origin_host) and origin_host == req_host


BUDGET_MAX = 1_000_000.0
_PROVIDER_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,39}$")
_settings_save_lock = threading.Lock()


def _positive_number(value):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) and 0 < n <= BUDGET_MAX else None


def _budget_map(raw) -> dict:
    out: dict[str, float] = {}
    if not isinstance(raw, dict):
        return out
    for key, value in list(raw.items())[:40]:
        name = str(key).strip().lower()
        amount = _positive_number(value)
        if _PROVIDER_KEY_RE.match(name) and amount:
            out[name] = round(amount, 2)
    return out


def _webhook_url(value) -> str:
    """Webhook só para HTTPS ou loopback: custo não sai para um destino inseguro."""
    url = str(value or "").strip()
    if not url or len(url) > 500:
        return ""
    try:
        parsed = urlparse(url)
    except ValueError:
        return ""
    if parsed.scheme == "https" and parsed.hostname:
        return url
    if parsed.scheme == "http" and (parsed.hostname or "").lower() in ("127.0.0.1", "localhost", "::1"):
        return url
    return ""


def normalize_settings(raw) -> dict:
    src = raw if isinstance(raw, dict) else {}
    budgets = src.get("budgets") if isinstance(src.get("budgets"), dict) else {}
    alerts = src.get("alerts") if isinstance(src.get("alerts"), dict) else {}
    try:
        threshold = int(budgets.get("threshold"))
    except (TypeError, ValueError):
        threshold = 80
    if threshold not in (50, 60, 70, 80, 90):
        threshold = 80
    try:
        cooldown = int(alerts.get("cooldown_min"))
    except (TypeError, ValueError):
        cooldown = 360
    return {
        "budgets": {
            "global": round(_positive_number(budgets.get("global")) or 0, 2) or None,
            "providers": _budget_map(budgets.get("providers")),
            "threshold": threshold,
        },
        "alerts": {
            "macos": bool(alerts.get("macos", True)),
            "webhook": _webhook_url(alerts.get("webhook")),
            "cooldown_min": min(1440, max(5, cooldown)),
        },
    }


def load_settings() -> dict:
    return normalize_settings(_read_json(SETTINGS_FILE))


def _write_private(path: Path, payload: dict) -> None:
    RUNE_DATA.mkdir(parents=True, exist_ok=True)
    os.chmod(RUNE_DATA, 0o700)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def save_settings(settings: dict) -> dict:
    clean = normalize_settings(settings)
    with _settings_save_lock:
        _write_private(SETTINGS_FILE, {
            "version": 1,
            "updated_at": datetime.now().astimezone().isoformat(),
            **clean,
        })
    return clean


def public_settings() -> dict:
    """O webhook nunca volta completo: o token na URL é um segredo, como uma chave."""
    settings = load_settings()
    webhook = settings["alerts"]["webhook"]
    host = ""
    if webhook:
        try:
            host = urlparse(webhook).hostname or ""
        except ValueError:
            host = ""
    updated = _read_json(SETTINGS_FILE).get("updated_at")
    return {
        "budgets": settings["budgets"],
        "alerts": {
            "macos": settings["alerts"]["macos"],
            "cooldown_min": settings["alerts"]["cooldown_min"],
            "webhook_set": bool(webhook),
            "webhook_host": host,
        },
        "updated_at": updated if isinstance(updated, str) else None,
    }


def budget_alerts(month: dict, settings: dict) -> list[dict]:
    """Alertas de orçamento calculados no servidor: valem com a aba fechada e vão para o webhook."""
    threshold = settings["budgets"]["threshold"]
    rows: list[dict] = []

    def check(scope: str, label: str, spent: float, limit: float | None, is_global: bool) -> None:
        if not limit:
            return
        ratio = round(spent / limit * 100, 1)
        if ratio < threshold:
            return
        over = ratio >= 100
        rows.append({
            "kind": "budget",
            "key": f"budget:{scope}",
            "budget": "global" if is_global else scope,
            "level": "over" if over else "warn",
            "tone": "bad" if over else "warn",
            "pct": ratio,
            "spent": round(spent, 4),
            "limit": round(limit, 2),
            "title": f"Orçamento {'estourado' if over else 'perto do limite'} · {label} ({ratio:.0f}%)",
            "detail": f"US$ {spent:.2f} de US$ {limit:.2f} no mês. Projeção US$ {float(month.get('projected') or 0):.2f}.",
            "provider": "budget" if is_global else scope,
        })

    if month:
        check("global", "total", float(month.get("cost") or 0), settings["budgets"]["global"], True)
        for provider, limit in settings["budgets"]["providers"].items():
            spent = (month.get("byProvider") or {}).get(provider, 0)
            check(provider, provider, float(spent or 0), limit, False)
    rows.sort(key=lambda r: (r["budget"] != "global", -r["pct"]))
    return rows


def due_alerts(alerts: list[dict], previous: dict, now: datetime, cooldown_min: int) -> list[dict]:
    """Repete o aviso só quando o nível muda ou o cooldown venceu."""
    due = []
    for alert in alerts:
        prev = previous.get(alert["key"]) or {}
        try:
            last = datetime.fromisoformat(str(prev.get("at") or ""))
        except ValueError:
            last = None
        if last is not None and last.tzinfo is None:
            last = last.astimezone()
        if prev.get("level") != alert["level"] or last is None or (now - last) >= timedelta(minutes=cooldown_min):
            due.append(alert)
    return due


def _notify_state() -> dict:
    raw = _read_json(NOTIFY_FILE)
    alerts = raw.get("alerts") if isinstance(raw.get("alerts"), dict) else {}
    return {str(key): value for key, value in alerts.items() if isinstance(value, dict)}


def _macos_notification(title: str, message: str) -> None:
    script = 'on run argv\n  display notification (item 2 of argv) with title (item 1 of argv)\nend run'
    subprocess.run(["osascript", "-e", script, title, message], capture_output=True, timeout=8)


def _post_webhook(url: str, payload: dict) -> None:
    target = _webhook_url(url)
    if not target:
        return
    request = urlrequest.Request(
        target,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "rune-live"},
        method="POST",
    )
    with urlrequest.urlopen(request, timeout=5) as response:
        response.read(256)


def alert_cycle(now: datetime | None = None, deliver: bool = True) -> dict:
    settings = load_settings()
    month = load_router_usage(days=2).get("month") or {}
    alerts = budget_alerts(month, settings)
    if not alerts:
        return {"alerts": [], "due": [], "sent": 0}
    now = now or datetime.now().astimezone()
    state = _notify_state()
    due = due_alerts(alerts, state, now, settings["alerts"]["cooldown_min"])
    if deliver and due:
        for alert in due:
            if settings["alerts"]["macos"]:
                try:
                    _macos_notification("Rune · orçamento", alert["title"])
                except (OSError, subprocess.SubprocessError):
                    pass
            if settings["alerts"]["webhook"]:
                try:
                    _post_webhook(settings["alerts"]["webhook"], {
                        "source": "rune", "kind": "budget", "level": alert["level"],
                        "budget": alert["budget"], "pct": alert["pct"],
                        "spent_usd": alert["spent"], "limit_usd": alert["limit"],
                        "title": alert["title"], "at": now.isoformat(),
                    })
                except (urlerror.URLError, TimeoutError, OSError, ValueError):
                    pass
        for alert in due:
            state[alert["key"]] = {"level": alert["level"], "at": now.isoformat(), "pct": alert["pct"]}
        try:
            _write_private(NOTIFY_FILE, {"version": 1, "updated_at": now.isoformat(), "alerts": state})
        except OSError:
            pass
    return {"alerts": alerts, "due": [a["key"] for a in due], "sent": len(due) if deliver else 0}


def _alert_loop(interval: float) -> None:
    time.sleep(min(interval, 15.0))
    while True:
        try:
            alert_cycle()
        except Exception:  # noqa: BLE001 — um ciclo ruim não pode derrubar o vigia
            pass
        time.sleep(interval)


def start_alert_watcher() -> None:
    if (os.environ.get("RUNE_ALERTS") or "1").strip() == "0":
        return
    try:
        interval = max(30.0, float(os.environ.get("RUNE_ALERT_INTERVAL", "300")))
    except ValueError:
        interval = 300.0
    threading.Thread(target=_alert_loop, args=(interval,), name="rune-alerts", daemon=True).start()


def load_router_usage(days: int = 14) -> dict:
    """Série diária e chamadas recentes direto do banco do 9router."""
    out = {"days": [], "recent": [], "providers": {}, "models": {}, "errors": [], "today": {},
           "month": {}, "slo": {"providers": [], "overall": {}, "window": "7d"}}
    conn = _ro(ROUTER_DB)
    if conn is None:
        return out
    try:
        raw_days: dict[str, dict] = {}
        for row in conn.execute("SELECT dateKey, data FROM usageDaily"):
            try:
                raw_days[row["dateKey"]] = json.loads(row["data"] or "{}")
            except ValueError:
                continue

        end = datetime.now().astimezone().date()
        by_model: dict[tuple[str, str], dict] = {}
        by_provider: dict[str, dict] = {}
        for i in range(days - 1, -1, -1):
            day = end - timedelta(days=i)
            key = day.isoformat()
            d = raw_days.get(key, {})
            prompt = int(d.get("promptTokens", 0))
            completion = int(d.get("completionTokens", 0))
            cached = int(d.get("cachedTokens", 0))
            entry = {
                "date": key,
                "label": day.strftime("%d/%m"),
                "weekday": ["S", "T", "Q", "Q", "S", "S", "D"][day.weekday()],
                "requests": int(d.get("requests", 0)),
                "input": prompt,
                "output": completion,
                "cached": cached,
                "tokens": prompt + completion,
                "cost": round(float(d.get("cost", 0)), 4),
                "providers": {},
            }
            for prov, pdata in (d.get("byProvider") or {}).items():
                pt = int(pdata.get("promptTokens", 0))
                ct = int(pdata.get("completionTokens", 0))
                ca = int(pdata.get("cachedTokens", 0))
                entry["providers"][prov] = {
                    "requests": int(pdata.get("requests", 0)),
                    "tokens": pt + ct,
                    "input": pt,
                    "cached": ca,
                    "cost": round(float(pdata.get("cost", 0)), 4),
                }
                agg = by_provider.setdefault(prov, {"provider": prov, "requests": 0, "tokens": 0, "input": 0, "cached": 0, "cost": 0.0})
                agg["requests"] += int(pdata.get("requests", 0))
                agg["tokens"] += pt + ct
                agg["input"] += pt
                agg["cached"] += ca
                agg["cost"] += float(pdata.get("cost", 0))
            for raw_key, mdata in (d.get("byModel") or {}).items():
                model = mdata.get("rawModel") or raw_key.split("|", 1)[0]
                prov = mdata.get("provider") or (raw_key.split("|") + [""])[1]
                agg = by_model.setdefault((prov, model), {"provider": prov, "model": model, "requests": 0, "tokens": 0, "input": 0, "cached": 0, "cost": 0.0})
                pt = int(mdata.get("promptTokens", 0))
                ct = int(mdata.get("completionTokens", 0))
                agg["requests"] += int(mdata.get("requests", 0))
                agg["tokens"] += pt + ct
                agg["input"] += pt
                agg["cached"] += int(mdata.get("cachedTokens", 0))
                agg["cost"] += float(mdata.get("cost", 0))
            out["days"].append(entry)

        start_date = end - timedelta(days=days - 1)
        month_start = end.replace(day=1)
        month_active: set[str] = set()
        month = {"month": end.strftime("%Y-%m"), "cost": 0.0, "tokens": 0, "requests": 0,
                 "input": 0, "cached": 0, "providers": {}}
        hours: dict[str, list[dict]] = {}
        for row in conn.execute("SELECT timestamp, provider, promptTokens, completionTokens, cost, tokens FROM usageHistory"):
            raw_ts = row["timestamp"]
            if not raw_ts:
                continue
            try:
                ts = datetime.fromisoformat(raw_ts.replace("Z", "+00:00")).astimezone()
            except ValueError:
                continue
            try:
                tok = json.loads(row["tokens"] or "{}")
            except ValueError:
                tok = {}
            total = _tokens(row["promptTokens"], row["completionTokens"])
            cost = float(row["cost"] or 0)
            prov = row["provider"]

            if ts.date() >= month_start:
                month_active.add(ts.date().isoformat())
                month["requests"] += 1
                month["tokens"] += total
                month["input"] += int(row["promptTokens"] or 0)
                month["cached"] += int(tok.get("cached_tokens", 0) or 0)
                month["cost"] += cost
                mp = month["providers"].setdefault(prov, {"provider": prov, "requests": 0, "tokens": 0, "cost": 0.0})
                mp["requests"] += 1
                mp["tokens"] += total
                mp["cost"] += cost

            if ts.date() < start_date:
                continue
            key = ts.date().isoformat()
            bucket = hours.setdefault(key, [
                {"hour": h, "requests": 0, "tokens": 0, "cost": 0.0, "providers": {}} for h in range(24)
            ])
            ent = bucket[ts.hour]
            ent["requests"] += 1
            ent["tokens"] += total
            ent["cost"] = round(ent["cost"] + cost, 5)
            p = ent["providers"].setdefault(prov, {"requests": 0, "tokens": 0, "cost": 0.0})
            p["requests"] += 1
            p["tokens"] += total
            p["cost"] = round(p["cost"] + cost, 5)
        out["hours"] = hours

        elapsed = max(1, end.day)
        days_in_month = calendar.monthrange(end.year, end.month)[1]
        month_cost = round(month["cost"], 4)
        month["cost"] = month_cost
        month["cache_hit"] = _pct(month["cached"], month["input"])
        month["elapsed"] = elapsed
        month["days_in_month"] = days_in_month
        month["active_days"] = len(month_active)
        month["projected"] = round(month_cost / elapsed * days_in_month, 4)
        month["byProvider"] = {key: round(val["cost"], 4) for key, val in month["providers"].items()}
        month["providers"] = sorted(month["providers"].values(), key=lambda x: x["cost"], reverse=True)
        for row in month["providers"]:
            row["cost"] = round(row["cost"], 4)
            row["share"] = _pct(row["tokens"], month["tokens"])
        out["month"] = month

        out["today"] = out["days"][-1] if out["days"] else {}
        out["providers"] = sorted(by_provider.values(), key=lambda x: x["tokens"], reverse=True)
        out["models"] = sorted(by_model.values(), key=lambda x: x["tokens"], reverse=True)
        for p in out["providers"]:
            p["cost"] = round(p["cost"], 4)
            p["share"] = _pct(p["tokens"], sum(x["tokens"] for x in out["providers"]))
        for m in out["models"]:
            m["cost"] = round(m["cost"], 4)
            m["share"] = _pct(m["tokens"], sum(x["tokens"] for x in out["models"]))

        for row in conn.execute(
            """SELECT timestamp, provider, model, promptTokens, completionTokens, cost, status, tokens
               FROM usageHistory ORDER BY timestamp DESC LIMIT 160"""
        ):
            try:
                tok = json.loads(row["tokens"] or "{}")
            except ValueError:
                tok = {}
            out["recent"].append({
                "timestamp": row["timestamp"],
                "time": _hhmm(row["timestamp"]),
                "provider": row["provider"],
                "model": row["model"],
                "input": int(row["promptTokens"] or 0),
                "output": int(row["completionTokens"] or 0),
                "cached": int(tok.get("cached_tokens", 0) or 0),
                "cost": round(float(row["cost"] or 0), 5),
                "status": row["status"] or "ok",
            })

        groups: dict[str, dict] = {}
        for row in conn.execute(
            """SELECT timestamp, provider, model, status, data FROM requestDetails
               WHERE status='error' ORDER BY timestamp DESC LIMIT 400"""
        ):
            try:
                payload = json.loads(row["data"] or "{}")
            except ValueError:
                continue
            resp = payload.get("response") or {}
            raw = _error_message(resp.get("error") or resp.get("message") or resp)
            msg = _clean(raw, 300) or "Falha sem mensagem do provedor"
            msg = re.sub(r"\b[0-9a-f]{8}-[0-9a-f-]{20,}\b", "•••", msg, flags=re.I)
            msg = re.sub(r"https?://\S+", "endpoint do provedor", msg)
            status_code = resp.get("status")
            key = f"{row['provider']}|{row['model']}|{msg[:120]}"
            g = groups.setdefault(key, {"provider": row["provider"], "model": row["model"], "message": msg, "count": 0, "last": row["timestamp"], "code": None})
            g["count"] += 1
            if g["last"] < row["timestamp"]:
                g["last"] = row["timestamp"]
            if status_code:
                try:
                    g["code"] = int(status_code)
                except (TypeError, ValueError):
                    pass
            m = re.search(r"\b(429|403|404|401|410|500|502|503)\b", msg)
            if m and not g["code"]:
                g["code"] = int(m.group(1))
        out["errors"] = sorted(groups.values(), key=lambda x: (x["last"], x["count"]), reverse=True)[:14]
        for e in out["errors"]:
            e["diagnosis"] = diagnose(e["message"], e["provider"], e["model"])
            e["prompt"] = error_prompt(e)

        slo: dict[str, dict] = {}
        overall = {"provider": "all", "requests": 0, "errors": 0, "lat": [], "ttft": []}
        cutoff = datetime.now(timezone.utc) - timedelta(days=7)
        for row in conn.execute(
            "SELECT timestamp, provider, status, data FROM requestDetails ORDER BY timestamp DESC LIMIT 5000"
        ):
            raw_ts = row["timestamp"]
            if not raw_ts:
                continue
            try:
                ts = datetime.fromisoformat(raw_ts.replace("Z", "+00:00"))
            except ValueError:
                continue
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if ts < cutoff:
                continue
            provider = row["provider"] or "—"
            try:
                payload = json.loads(row["data"] or "{}")
            except ValueError:
                payload = {}
            latency = payload.get("latency") or {}
            total = latency.get("total")
            ttft = latency.get("ttft")
            failed = (row["status"] or "").lower() != "success"
            for target in (slo.setdefault(provider, {"provider": provider, "requests": 0, "errors": 0, "lat": [], "ttft": []}), overall):
                target["requests"] += 1
                if failed:
                    target["errors"] += 1
                if isinstance(total, (int, float)) and total > 0:
                    target["lat"].append(float(total))
                if isinstance(ttft, (int, float)) and ttft > 0:
                    target["ttft"].append(float(ttft))
        for target in [*slo.values(), overall]:
            target["errorRate"] = _pct(target["errors"], target["requests"])
            target["tone"] = _slo_tone(target["errorRate"], _pctile(target["lat"], 95))
            target["p50"] = _round_ms(_pctile(target["lat"], 50))
            target["p95"] = _round_ms(_pctile(target["lat"], 95))
            target["ttftP50"] = _round_ms(_pctile(target["ttft"], 50))
            target.pop("lat", None)
            target.pop("ttft", None)
        out["slo"] = {
            "providers": sorted(slo.values(), key=lambda x: x["requests"], reverse=True),
            "overall": overall,
            "window": "7d",
        }
    finally:
        conn.close()
    return out


MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def resolve_month(month: str) -> str:
    return month if MONTH_RE.fullmatch(month or "") else datetime.now().astimezone().strftime("%Y-%m")


def month_accounting(month: str = "") -> list[dict]:
    """Fechamento do mês por dia, provedor e modelo — o recorte que uma nota de reembolso pede."""
    target = resolve_month(month)
    rows: dict[tuple[str, str, str], dict] = {}
    conn = _ro(ROUTER_DB)
    if conn is None:
        return []
    try:
        for row in conn.execute(
            "SELECT timestamp, provider, model, promptTokens, completionTokens, cost FROM usageHistory"
        ):
            try:
                ts = datetime.fromisoformat(str(row["timestamp"] or "").replace("Z", "+00:00")).astimezone()
            except (TypeError, ValueError):
                continue
            if ts.strftime("%Y-%m") != target:
                continue
            provider = str(row["provider"] or "desconhecido")
            model = str(row["model"] or "desconhecido")
            key = (ts.date().isoformat(), provider, model)
            ent = rows.setdefault(key, {
                "date": key[0], "provider": provider, "model": model,
                "requests": 0, "input": 0, "output": 0, "cost": 0.0,
            })
            ent["requests"] += 1
            ent["input"] += int(row["promptTokens"] or 0)
            ent["output"] += int(row["completionTokens"] or 0)
            ent["cost"] += float(row["cost"] or 0)
    finally:
        conn.close()
    out = sorted(rows.values(), key=lambda r: (r["date"], r["provider"], r["model"]))
    for row in out:
        row["tokens"] = row["input"] + row["output"]
        row["cost"] = round(row["cost"], 6)
    return out


def _csv_cell(value) -> str:
    """Planilha interpreta =, +, - e @ como fórmula; o apóstrofo mantém o texto literal."""
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@") else text


def accounting_csv(month: str = "") -> tuple[str, str]:
    resolved = resolve_month(month)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["date", "provider", "model", "requests", "input_tokens",
                     "output_tokens", "tokens", "currency", "cost_usd"])
    for row in month_accounting(resolved):
        writer.writerow([
            row["date"], _csv_cell(row["provider"]), _csv_cell(row["model"]),
            row["requests"], row["input"], row["output"], row["tokens"], "USD", f"{row['cost']:.6f}",
        ])
    return resolved, "\ufeff" + buffer.getvalue()


def _pctile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(round((p / 100) * (len(ordered) - 1)))))
    return ordered[index]


def _round_ms(value: float | None) -> int | None:
    return int(round(value)) if value is not None else None


def _slo_tone(error_rate: float, p95: float | None) -> str:
    if error_rate >= 5 or (p95 is not None and p95 >= 45000):
        return "bad"
    if error_rate >= 1 or (p95 is not None and p95 >= 25000):
        return "warn"
    return "ok"


def diagnose(message: str, provider: str, model: str) -> dict:
    s = (message or "").lower()
    if "credits_required" in s or "usage credits" in s:
        return {"title": "Créditos exigidos para este modelo", "tone": "warn",
                "cause": "O provedor aceita a conexão, mas o modelo premium exige crédito extra ou uma janela de uso diferente.",
                "fix": "Trocar para um modelo incluído no plano, ativar créditos extras ou rotear este modelo para outro provedor."}
    if "retired" in s or "end of life" in s or "no longer available" in s or "not a valid model" in s:
        return {"title": "Modelo aposentado", "tone": "warn",
                "cause": f"O modelo {model} saiu do catálogo do provedor {provider}; o pedido continua sendo enviado.",
                "fix": "Remover o modelo do combo/rota e apontar para o substituto indicado pelo provedor."}
    if "not found for account" in s or ("function" in s and "not found" in s):
        return {"title": "Recurso sem acesso na conta", "tone": "bad",
                "cause": "A conta ou chave atual não tem permissão para esta função/modelo no provedor.",
                "fix": "Conferir permissões da chave no painel do provedor e habilitar o modelo antes de repetir."}
    if "could not route" in s or "7003" in s or ("route" in s and "account" in s):
        return {"title": "Rota de conta inválida", "tone": "bad",
                "cause": "O provedor não reconhece o identificador da conta usado na URL; a conexão parece válida, mas a rota está errada.",
                "fix": "Reconectar usando o account ID correto e testar um modelo barato antes de habilitar o combo."}
    if "gone" in s or "410" in s:
        return {"title": "Modelo removido do upstream", "tone": "warn",
                "cause": "O upstream respondeu 410: o endpoint ou modelo deixou de existir.",
                "fix": "Atualizar o catálogo, remover o modelo das rotas e configurar um equivalente."}
    if "rate_limit" in s or "429" in s:
        return {"title": "Limite de taxa", "tone": "warn",
                "cause": "Rajadas de chamadas dentro da mesma janela de uso.",
                "fix": "Aplicar retry com backoff exponencial e limitar a concorrência; usar fallback quando a janela estourar."}
    if "403" in s or "forbidden" in s or "permission" in s:
        return {"title": "Permissão negada", "tone": "bad",
                "cause": "Token sem o escopo necessário, conta sem acesso ao modelo ou região bloqueada.",
                "fix": "Reautorizar a conexão e conferir escopos/plano antes de repetir a chamada."}
    if "not found" in s or "404" in s or "unavailable" in s or "api_error" in s:
        return {"title": "Modelo indisponível", "tone": "warn",
                "cause": "O identificador do modelo não existe neste provedor, saiu do catálogo ou está temporariamente fora.",
                "fix": "Atualizar o catálogo e configurar um fallback com modelo equivalente."}
    if ("context" in s or "token" in s) and "limit" in s:
        return {"title": "Contexto acima do limite", "tone": "warn",
                "cause": "A sessão acumulou mais contexto do que a janela do modelo suporta.",
                "fix": "Compactar o contexto, remover leituras duplicadas e dividir a tarefa em etapas."}
    return {"title": "Falha do provedor", "tone": "warn",
            "cause": "Resposta de erro do upstream sem classificação automática.",
            "fix": "Repetir com backoff, validar a conexão e configurar fallback."}


def error_prompt(e: dict) -> str:
    return (
        "Contexto do Rune (local, sem segredos):\n"
        f"- Provedor: {e['provider']}\n- Modelo: {e['model']}\n- Ocorrências: {e['count']}\n"
        f"- Última: {e['last']}\n- Erro normalizado: {e['message']}\n"
        f"- Causa provável: {e['diagnosis']['cause']}\n"
        "Ajude-me a corrigir isso no 9router. Proponha: (1) diagnóstico, (2) política de retry/fallback, "
        "(3) mudança de configuração segura. Não peça nem exponha chaves ou tokens."
    )


def load_qoder() -> dict:
    out = {"sessions": [], "skills": {"total": 0, "included": 0, "top": []},
           "duplicates": [], "artifacts": {"images": 0, "attachments": 0, "fileChanges": 0},
           "agents": 0, "messages": 0}
    conn = _ro(QODER_DB)
    if conn is None:
        return out
    try:
        ctx: dict[str, dict] = {}
        duplicates: dict[str, dict] = {}
        skills_top: dict[str, dict] = {}
        latest_skills = None
        for row in conn.execute("SELECT session_id, snapshot_json, updated_at FROM chat_session_context_usage"):
            try:
                snap = json.loads(row["snapshot_json"] or "{}")
            except ValueError:
                continue
            info = {
                "pct": round(float(snap.get("percentage", 0)) * 100, 1),
                "categories": [{"name": c.get("name"), "pct": round(float(c.get("percentage", 0)) * 100, 1)} for c in snap.get("categories", [])],
                "skills": snap.get("skills") or {},
                "duplicates": snap.get("duplicateFileReads") or [],
                "stats": snap.get("sessionStats") or {},
                "updated_at": row["updated_at"],
            }
            if row["session_id"] not in ctx or (ctx[row["session_id"]]["updated_at"] or 0) < (row["updated_at"] or 0):
                ctx[row["session_id"]] = info
            for d in info["duplicates"]:
                path = d.get("path") or ""
                if not path:
                    continue
                g = duplicates.setdefault(path, {"path": path, "reads": 0, "wasted": 0})
                g["reads"] = max(g["reads"], int(d.get("count", 0) or 0))
                if d.get("wastedTokens"):
                    g["wasted"] = max(g["wasted"], int(d.get("wastedTokens") or 0))
                if not g["wasted"] and g["reads"] > 1:
                    try:
                        size = os.path.getsize(path)
                        g["wasted"] = (g["reads"] - 1) * ((size + 3) // 4)
                    except OSError:
                        pass
            sk = info["skills"]
            if sk.get("skillFrontmatter"):
                latest_skills = sk
                for s in sk["skillFrontmatter"]:
                    name = s.get("name") or "skill"
                    skills_top[name] = {
                        "name": name,
                        "source": s.get("source") or "local",
                        "pct": round(float(s.get("percentageOfContext", 0)) * 100, 3),
                    }

        sessions = []
        for row in conn.execute(
            """SELECT s.session_id, s.title, s.cwd, s.model, s.created_at, s.updated_at, s.product_mode,
                      (SELECT COUNT(*) FROM chat_session_messages m WHERE m.session_id = s.session_id) AS msgs
               FROM chat_sessions s
               WHERE COALESCE(s.deleted_at, 0) = 0
               ORDER BY s.updated_at DESC LIMIT 14"""
        ):
            c = ctx.get(row["session_id"], {})
            project = Path(row["cwd"]).name if row["cwd"] else "sem projeto"
            sessions.append({
                "id": row["session_id"],
                "title": row["title"] or project,
                "project": project,
                "cwd": row["cwd"] or "",
                "model": row["model"] or "auto",
                "mode": row["product_mode"] or "",
                "messages": int(row["msgs"] or 0),
                "created_at": _iso(row["created_at"]),
                "updated_at": _iso(row["updated_at"]),
                "context_pct": c.get("pct", 0),
                "context": c.get("categories", []),
                "duplicates": len(c.get("duplicates", [])),
                "tool_calls": (c.get("stats") or {}).get("toolCalls", {}).get("total", 0),
            })
        try:
            out["agents"] = conn.execute("SELECT COUNT(*) FROM agent_profiles WHERE archived_at IS NULL").fetchone()[0]
        except sqlite3.Error:
            pass
        try:
            out["messages"] = conn.execute("SELECT COUNT(*) FROM chat_session_messages").fetchone()[0]
        except sqlite3.Error:
            pass
        for table, key in (("chat_generated_image_assets", "images"), ("chat_attachment_assets", "attachments"), ("turn_file_change_sets", "fileChanges")):
            try:
                out["artifacts"][key] = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            except sqlite3.Error:
                pass
        out["sessions"] = sessions
        out["duplicates"] = sorted(duplicates.values(), key=lambda x: (x["reads"], x["wasted"]), reverse=True)
        if latest_skills:
            out["skills"] = {
                "total": int(latest_skills.get("totalSkills", 0) or 0),
                "included": int(latest_skills.get("includedSkills", 0) or 0),
                "top": sorted(skills_top.values(), key=lambda x: x["pct"], reverse=True)[:24],
            }
    finally:
        conn.close()
    return out


def load_errors_fallback(data: dict) -> list[dict]:
    errs = []
    for conn in data.get("connections", []):
        if conn.get("status") in ("error", "unavailable") or conn.get("errorCode"):
            e = {
                "provider": conn.get("provider", "?"),
                "model": "conexão",
                "message": _clean(conn.get("error") or "Conexão indisponível"),
                "count": 1,
                "last": conn.get("lastUsedAt") or "",
                "code": conn.get("errorCode"),
            }
            e["diagnosis"] = diagnose(e["message"], e["provider"], e["model"])
            e["prompt"] = error_prompt(e)
            errs.append(e)
    return errs


def normalize_quota(data: dict) -> dict:
    q = data.get("quota") or {}
    codex = q.get("codex") or {}
    claude = q.get("claude") or {}
    google = q.get("google") or {}
    out = {"codex": {"available": bool(codex.get("available"))}, "claude": {"available": bool(claude.get("available"))}, "google": {"available": bool(google.get("available"))}}
    if codex:
        primary = codex.get("primary") or {}
        weekly = codex.get("weekly") or {}
        budget = codex.get("budget") or {}
        out["codex"].update({
            "plan": codex.get("plan"),
            "session_used": primary.get("used_percent"),
            "session_free": round(100 - float(primary.get("used_percent", 0)), 1) if primary else None,
            "session_reset": primary.get("reset_at"),
            "session_hours": round(float(primary.get("reset_after_seconds", 0)) / 3600, 1) if primary else None,
            "week_used": weekly.get("used_percent"),
            "week_free": round(100 - float(weekly.get("used_percent", 0)), 1) if weekly else None,
            "week_reset": weekly.get("reset_at"),
            "week_days": weekly.get("days_left"),
            "pace": budget.get("pace_percent_per_day"),
            "target": budget.get("daily_target_percent"),
            "alert": budget.get("alert_percent"),
            "reset_credits": codex.get("reset_credits"),
            "credits": codex.get("credits"),
            "limit_reached": codex.get("limit_reached"),
        })
    if claude:
        raw = claude.get("raw") or {}
        five = raw.get("five_hour") or {}
        week = raw.get("seven_day") or {}
        extra = raw.get("iguana_necktie") or {}
        out["claude"].update({
            "session_used": five.get("utilization"),
            "session_free": round(100 - float(five.get("utilization", 0)), 1) if five else None,
            "session_reset": five.get("resets_at"),
            "week_used": week.get("utilization"),
            "week_free": round(100 - float(week.get("utilization", 0)), 1) if week else None,
            "week_reset": week.get("resets_at"),
            "credit_limit": extra.get("limit_dollars"),
            "credit_used": extra.get("used_dollars"),
            "credit_free": round(100 - float(extra.get("utilization", 0)) * 100, 2) if extra else None,
            "credit_reset": extra.get("resets_at"),
            "locked": five.get("locked_reason"),
        })
    if not google.get("available"):
        out["google"]["error"] = _clean(google.get("error") or "sem medição de cota")
    return out


# ---------------------------------------------------------------- frota viva
# Catálogo lido do 9router local em /v1/models. Nenhum prompt ou chave sai
# daqui: o painel só recebe nomes de modelos, contagens e capacidades.

OWNER_META = {
    "combo": ("Combos", None),
    "cc": ("Claude Code", "claude"),
    "ag": ("Antigravity", "antigravity"),
    "cx": ("Codex", "codex"),
    "gc": ("Gemini CLI", "gemini-cli"),
    "gemini": ("Gemini API", "gemini"),
    "openrouter": ("OpenRouter", "openrouter"),
    "nvidia": ("NVIDIA NIM", "nvidia"),
    "cf": ("Cloudflare Workers AI", "cloudflare-ai"),
    "ollama": ("Ollama local", "ollama"),
    "oc": ("OpenCode Zen", "opencode"),
    "mmf": ("Mimo", "mimo"),
}
FREE_OWNERS = {"ollama", "cf", "oc", "nvidia"}

_catalog_cache: dict = {"at": 0.0, "data": None}
_catalog_raw: dict = {"by_owner": {}}
_probe_cache: dict[str, dict] = {}
_route_cache: dict[str, str] = {}
_conn_cache: dict[str, dict] = {}
_dead_models: dict[str, float] = {}
_fleet_lock = threading.Lock()
_fleet_save_lock = threading.Lock()
# Semáforo: no máximo 3 sondagens simultâneas para não saturar a máquina.
_probe_lock = threading.BoundedSemaphore(3)


def _load_fleet_state() -> dict[str, dict]:
    """Último resultado conhecido de cada rota, para sobreviver ao reload da aba."""
    raw = _read_json(FLEET_FILE)
    rows = raw.get("routes") if isinstance(raw.get("routes"), dict) else {}
    out: dict[str, dict] = {}
    for key, row in rows.items():
        if not isinstance(row, dict):
            continue
        out[str(key)] = {
            "ok": bool(row.get("ok")),
            "model": _clean(row.get("model"), 160),
            "ms": row.get("ms") if isinstance(row.get("ms"), int) else None,
            "code": row.get("code") if isinstance(row.get("code"), int) else None,
            "error": _clean(row.get("error"), 160),
            "checked_at": row.get("checked_at"),
            "last_ok": row.get("last_ok"),
            "last_ok_ms": row.get("last_ok_ms"),
            "last_ok_model": _clean(row.get("last_ok_model"), 160),
        }
    return out


_fleet_state: dict[str, dict] = _load_fleet_state()


def _save_fleet_state() -> None:
    with _fleet_save_lock:
        with _fleet_lock:
            payload = {
                "version": 1,
                "updated_at": datetime.now().astimezone().isoformat(),
                "routes": _fleet_state,
            }
        tmp = FLEET_FILE.with_suffix(".tmp")
        try:
            RUNE_DATA.mkdir(parents=True, exist_ok=True)
            os.chmod(RUNE_DATA, 0o700)
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            os.chmod(tmp, 0o600)
            os.replace(tmp, FLEET_FILE)
        except OSError:
            pass


def fleet_routes() -> list[dict]:
    with _fleet_lock:
        rows = [{"connection": key, **row} for key, row in _fleet_state.items()]
    return sorted(rows, key=lambda r: (not r.get("ok"), r["connection"]))


def _record_probe(result: dict) -> None:
    key = str(result.get("connection") or "")
    if not key:
        return
    now_iso = datetime.now().astimezone().isoformat()
    with _fleet_lock:
        prev = _fleet_state.get(key) or {}
        row = {
            "ok": bool(result.get("ok")),
            "model": _clean(result.get("model"), 160),
            "ms": result.get("ms") if isinstance(result.get("ms"), int) else None,
            "code": result.get("code") if isinstance(result.get("code"), int) else None,
            "error": _clean(result.get("error"), 160),
            "checked_at": now_iso,
            "last_ok": prev.get("last_ok"),
            "last_ok_ms": prev.get("last_ok_ms"),
            "last_ok_model": prev.get("last_ok_model"),
        }
        if row["ok"]:
            row["last_ok"] = now_iso
            row["last_ok_ms"] = row["ms"]
            row["last_ok_model"] = row["model"]
        _fleet_state[key] = row
    _save_fleet_state()


def router_catalog(force: bool = False) -> dict:
    """Lista o que o 9router tem plugado agora. Cache curto para não pesar o snapshot."""
    now = time.time()
    if not force:
        with _fleet_lock:
            cached = _catalog_cache["data"]
            ttl = _catalog_cache.get("ttl", 20)
            if cached and now - _catalog_cache["at"] < ttl:
                return cached
    started = time.time()
    out = {
        "online": False, "latency_ms": None, "total": 0, "owners": [], "combos": [],
        "checked_at": datetime.now().astimezone().isoformat(), "error": "",
    }
    try:
        req = urlrequest.Request(f"{ROUTER_URL}/v1/models", headers={"Accept": "application/json"})
        with urlrequest.urlopen(req, timeout=2.0) as resp:
            payload = json.loads(resp.read().decode("utf-8") or "{}")
        items = payload.get("data") or []
        owners: dict[str, dict] = {}
        by_owner: dict[str, list[str]] = {}
        for m in items:
            mid = str(m.get("id") or "")
            if not mid:
                continue
            oid = str(m.get("owned_by") or "?")
            caps = m.get("capabilities") or {}
            by_owner.setdefault(oid, []).append(mid)
            meta = OWNER_META.get(oid)
            row = owners.setdefault(oid, {
                "key": oid, "label": meta[0] if meta else oid,
                # Conexão nova no 9router vira rota sondável mesmo sem entrada fixa.
                "connection": meta[1] if meta else (oid if oid != "?" else None),
                "models": 0, "context": 0, "vision": False, "tools": False,
                "reasoning": False, "free": oid in FREE_OWNERS, "sample": [],
            })
            row["models"] += 1
            ctx = int(caps.get("contextWindow") or m.get("context_length") or 0)
            row["context"] = max(row["context"], ctx)
            row["vision"] = row["vision"] or bool(caps.get("vision"))
            row["tools"] = row["tools"] or bool(caps.get("tools"))
            row["reasoning"] = row["reasoning"] or bool(caps.get("reasoning"))
            row["free"] = row["free"] or "free" in mid.lower()
            if len(row["sample"]) < 2:
                row["sample"].append(mid)
        out.update({
            "online": True,
            "latency_ms": round((time.time() - started) * 1000, 1),
            "total": len(items),
            "owners": sorted(owners.values(), key=lambda r: (-r["models"], r["label"])),
            "combos": [{"name": name} for name in by_owner.get("combo", [])][:6],
        })
        with _fleet_lock:
            _catalog_raw["by_owner"] = by_owner
    except (urlerror.URLError, TimeoutError, OSError, ValueError) as exc:
        out["error"] = _clean(f"{type(exc).__name__}: {exc}", 140)
    with _fleet_lock:
        # Falha não pode envenenar a frota por 20s: tenta de novo em 3s.
        _catalog_cache.update({"at": now, "data": out, "ttl": 20 if out.get("online") else 3})
    return out


def _model_score(model: str) -> int:
    low = model.lower()
    score = 0
    if "free" in low:
        score += 8
    if "flash" in low:
        score += 4
    if re.search(r"mini|lite", low):
        score += 3
    if "haiku" in low:
        score += 2
    if "instruct" in low:
        score += 1
    return -score


# O catálogo do 9router carrega modelos já desligados (HTTP 410). Guardamos por
# quanto tempo cada modelo deve ser evitado para a próxima sondagem ser rápida.
DEAD_TTL = {410: 3600, 404: 900, 401: 900, 403: 600, 429: 180}


def _probe_candidates(owner: str, limit: int = 4) -> list[str]:
    if not _catalog_raw.get("by_owner"):
        router_catalog()
    ids = list((_catalog_raw.get("by_owner") or {}).get(owner, []))
    if not ids:
        return []
    now = time.time()
    alive = [m for m in ids if _dead_models.get(m, 0) < now]
    return sorted(alive or ids, key=_model_score)[:limit]


def _mark_dead(model: str, code) -> None:
    ttl = DEAD_TTL.get(code, 60)
    with _fleet_lock:
        _dead_models[model] = time.time() + ttl


def _owner_for_connection(connection: str) -> str:
    """Resolve rotas fixas e também conexões que o 9router ganhou depois do Rune."""
    known = next((o for o, (_, c) in OWNER_META.items() if c == connection), "")
    if known:
        return known
    if not _catalog_raw.get("by_owner"):
        router_catalog()
    return connection if connection in (_catalog_raw.get("by_owner") or {}) else ""


def probe_connection(connection: str, force: bool = False) -> dict:
    """Testa uma rota tentando até 4 modelos: o catálogo lista modelos mortos."""
    owner = _owner_for_connection(connection)
    if not owner:
        return {"ok": False, "connection": connection, "error": "rota desconhecida", "attempts": []}
    cached_conn = _conn_cache.get(connection)
    if not force and cached_conn and time.time() - cached_conn["_at"] < 60:
        return {k: v for k, v in cached_conn.items() if k != "_at"}
    cat = router_catalog()
    if not cat.get("online"):
        return {"ok": False, "connection": connection, "error": "9router não respondeu", "attempts": []}
    candidates = _probe_candidates(owner)
    cached = _route_cache.get(connection)
    if cached and cached not in candidates:
        candidates.insert(0, cached)
    if not candidates:
        return {"ok": False, "connection": connection, "error": "nenhum modelo nesta rota", "attempts": []}
    attempts: list[dict] = []
    deadline = time.time() + 45
    # O primeiro candidato é o mais provável; os seguintes valem menos espera.
    for i, model in enumerate(candidates[:4]):
        if time.time() > deadline:
            break
        res = probe_route(model, timeout=20 if i == 0 else 12)
        attempts.append({k: res.get(k) for k in ("model", "ok", "ms", "code", "error") if res.get(k) is not None})
        if res.get("ok"):
            _route_cache[connection] = model
            result = {
                "ok": True, "connection": connection, "owner": owner, "model": model,
                "ms": res.get("ms"), "tokens": res.get("tokens"),
                "models": cat.get("total"), "attempts": attempts,
            }
            _conn_cache[connection] = {**result, "_at": time.time()}
            _record_probe(result)
            return result
        _mark_dead(model, res.get("code"))
    result = {
        "ok": False, "connection": connection, "owner": owner,
        "error": (attempts[-1].get("error") if attempts else "sem resposta"),
        "attempts": attempts,
    }
    _conn_cache[connection] = {**result, "_at": time.time()}
    _record_probe(result)
    return result


def probe_all() -> list[dict]:
    """Sonda todas as rotas com no máximo 3 em paralelo, para poupar a máquina."""
    connections = {c for _, c in OWNER_META.values() if c}
    for owner in router_catalog().get("owners", []):
        if owner.get("connection"):
            connections.add(owner["connection"])
    with ThreadPoolExecutor(max_workers=3) as pool:
        return list(pool.map(probe_connection, sorted(connections)))


def _router_key() -> str:
    """Chave ativa só em memória, somente-leitura, para falar com o 9router local."""
    conn = _ro(ROUTER_DB)
    if conn is None:
        return ""
    try:
        row = conn.execute("SELECT key FROM apiKeys WHERE isActive=1 ORDER BY createdAt LIMIT 1").fetchone()
        return (row["key"] or "").strip() if row else ""
    except sqlite3.Error:
        return ""
    finally:
        conn.close()


def probe_route(model: str, timeout: float = 20.0) -> dict:
    """Mandada mínima (1 token) por uma rota do 9router para provar que ela responde."""
    model = (model or "").strip()
    if not model or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/@:\[\]-]{0,140}", model):
        return {"ok": False, "model": model, "error": "modelo inválido"}
    cached = _probe_cache.get(model)
    if cached and time.time() - cached["_at"] < 45:
        return {k: v for k, v in cached.items() if k != "_at"}
    cat = router_catalog()
    if not cat.get("online"):
        return {"ok": False, "model": model, "error": "9router não respondeu"}
    key = _router_key()
    if not key:
        return {"ok": False, "model": model, "error": "sem chave ativa no 9router"}
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1, "stream": False, "temperature": 0,
    }).encode("utf-8")
    req = urlrequest.Request(
        f"{ROUTER_URL}/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    started = time.time()
    with _probe_lock:
        try:
            with urlrequest.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8") or "{}")
            usage = data.get("usage") or {}
            result = {
                "ok": True, "model": model, "owner": str(data.get("model") or model).split("/")[0],
                "ms": round((time.time() - started) * 1000),
                "tokens": int(usage.get("total_tokens") or 0),
            }
        except urlerror.HTTPError as exc:
            detail = ""
            try:
                detail = _error_message(json.loads(exc.read().decode("utf-8") or "{}"))
            except (ValueError, OSError):
                detail = ""
            result = {
                "ok": False, "model": model, "code": exc.code,
                "ms": round((time.time() - started) * 1000),
                "error": _clean(detail or str(exc.reason), 160),
            }
        except (urlerror.URLError, TimeoutError, OSError, ValueError) as exc:
            result = {
                "ok": False, "model": model,
                "ms": round((time.time() - started) * 1000),
                "error": _clean(f"{type(exc).__name__}: {exc}", 160),
            }
        _probe_cache[model] = {**result, "_at": time.time()}
    return result


def build_snapshot() -> dict:
    data = _read_json(DATA_FILE)
    router = load_router_usage()
    qoder = load_qoder()
    now = datetime.now().astimezone()

    usage = data.get("usage") or {}
    days = router["days"]
    today = router["today"] or {}
    prev = days[-2] if len(days) > 1 else {}
    total_tokens = sum(d["tokens"] for d in days)
    total_cost = round(sum(d["cost"] for d in days), 4)
    total_req = sum(d["requests"] for d in days)
    total_cached = sum(d["cached"] for d in days)
    total_input = sum(d["input"] for d in days)
    active_days = [d for d in days if d["requests"]]
    avg = sum(d["tokens"] for d in active_days) / len(active_days) if active_days else 0
    cost_avg = sum(d["cost"] for d in active_days) / len(active_days) if active_days else 0

    errors = router["errors"] or load_errors_fallback(data)
    provider_health = {}
    for e in errors:
        p = provider_health.setdefault(e["provider"], {"errors": 0, "last": e["last"], "code": e["code"], "message": e["message"]})
        p["errors"] += e["count"]
        if e["last"] > p["last"]:
            p.update({"last": e["last"], "code": e["code"], "message": e["message"]})

    connections = []
    for c in data.get("connections") or []:
        connections.append({
            "provider": c.get("provider"),
            "name": c.get("name") or "conta",
            "auth": c.get("auth"),
            "active": bool(c.get("active")),
            "status": c.get("status"),
            "plan": c.get("plan") or "",
            "errorCode": c.get("errorCode"),
            "error": _clean(c.get("error"), 180),
            "lastUsedAt": c.get("lastUsedAt"),
            "expiresAt": c.get("expiresAt"),
            "health": provider_health.get(c.get("provider")),
        })

    # O catálogo vivo diz quantas rotas cada conexão realmente tem agora.
    fleet = {**router_catalog(), "routes": fleet_routes()}
    owner_rows = {row["key"]: row for row in fleet.get("owners") or []}
    for conn in connections:
        owner = next((o for o, (_, linked) in OWNER_META.items() if linked == conn["provider"]), "")
        row = owner_rows.get(owner)
        conn["owner"] = owner
        conn["models"] = row["models"] if row else 0
        conn["context"] = row["context"] if row else 0
        conn["capabilities"] = (
            {"vision": row["vision"], "tools": row["tools"], "reasoning": row["reasoning"]}
            if row else {"vision": False, "tools": False, "reasoning": False}
        )
        conn["free"] = bool(row and row["free"])

    keys = [{"name": k.get("name"), "keyId": k.get("keyId"), "active": bool(k.get("active")), "restricted": bool(k.get("restricted"))}
            for k in data.get("keys") or []]

    router_cfg = data.get("router_settings") or {}
    rune_settings = load_settings()
    settings_view = public_settings()
    inventory = data.get("inventory") or {}
    codex_inv = inventory.get("codex") or {}
    qoder_inv = inventory.get("qoder") or {}

    projects = []
    for p in data.get("projects") or []:
        projects.append({
            "name": p.get("name"), "path": p.get("path"), "kind": p.get("kind"),
            "origin": p.get("origin"), "ais": p.get("ais") or [],
            "sessions": int(p.get("sessions") or 0), "last_activity": p.get("last_activity"),
        })
    projects.sort(key=lambda x: (x["sessions"], x["last_activity"] or ""), reverse=True)

    suggestions = []
    for s in data.get("suggestions") or []:
        suggestions.append({"level": s.get("level"), "title": _clean(s.get("title"), 90), "detail": _clean(s.get("detail"), 260)})

    project_names = [p["name"] for p in projects if p.get("name")]
    for session in qoder.get("sessions", []):
        cwd = (session.get("cwd") or "").rstrip("/")
        match = next((name for name in project_names if cwd.endswith("/" + name)), None)
        session["project"] = match or "workspace Qoder"
        if (session.get("title") or "").startswith("http"):
            session["title"] = "Sessão sem título"

    quota = normalize_quota(data)
    codex_q = quota["codex"]
    claude_q = quota["claude"]

    sun_states = []
    if codex_q.get("available"):
        sun_states.append({
            "key": "codex-week", "provider": "codex", "eyebrow": "FOLGA · CODEX SEMANA",
            "pct": codex_q.get("week_free") if codex_q.get("week_free") is not None else 0,
            "sub": f"{codex_q.get('week_days', 0):.1f} dias".replace(".", ",") if codex_q.get("week_days") else "sem janela",
            "tag": f"ritmo {str(codex_q.get('pace', '—')).replace('.', ',')}%/dia · meta {str(codex_q.get('target', '—')).replace('.', ',')}%/dia",
            "reset": codex_q.get("week_reset"),
        })
        sun_states.append({
            "key": "codex-session", "provider": "codex", "eyebrow": "FOLGA · JANELA 5H",
            "pct": codex_q.get("session_free") if codex_q.get("session_free") is not None else 0,
            "sub": f"{codex_q.get('session_hours', 0):.1f}h".replace(".", ",") if codex_q.get("session_hours") else "sem janela",
            "tag": f"uso {codex_q.get('session_used', 0)}% da janela curta",
            "reset": codex_q.get("session_reset"),
        })
    if claude_q.get("available"):
        sun_states.append({
            "key": "claude-week", "provider": "claude", "eyebrow": "FOLGA · CLAUDE SEMANA",
            "pct": claude_q.get("week_free") if claude_q.get("week_free") is not None else 0,
            "sub": "7 dias",
            "tag": "conexão exige créditos para modelos premium",
            "reset": claude_q.get("week_reset"),
        })

    alerts = budget_alerts(router.get("month") or {}, rune_settings)
    seen_alerts = set()
    for e in errors[:6]:
        title = f"{e['provider']} · {e['diagnosis']['title']}"
        if title in seen_alerts:
            continue
        seen_alerts.add(title)
        alerts.append({"tone": "bad" if (e.get("code") or 0) >= 400 else "warn", "title": title, "detail": e["diagnosis"]["fix"], "provider": e["provider"]})
    if router_cfg.get("headroomEnabled") and not router_cfg.get("headroom_online"):
        alerts.append({"tone": "warn", "title": "Headroom ligado, mas offline", "detail": "Cada request tenta comprimir em localhost:8787 e falha. Ligue o serviço ou desligue a opção.", "provider": "router"})
    if today and prev and today.get("tokens", 0) > max(prev.get("tokens", 0) * 3, 1_000_000):
        alerts.append({"tone": "info", "title": "Pico de uso hoje", "detail": f"{today['tokens']/1e6:.1f}M tokens hoje contra {prev.get('tokens',0)/1e6:.2f}M ontem. O cache está segurando o custo.", "provider": "router"})

    top_provider = router["providers"][0] if router["providers"] else None
    top_model = router["models"][0] if router["models"] else None
    most_expensive = max(router["models"], key=lambda m: m["cost"], default=None)

    return {
        "meta": {
            "now": now.isoformat(),
            "now_label": now.strftime("%d/%m/%Y %H:%M"),
            "operator": _operator_name(),
            "host": socket.gethostname().replace(".local", ""),
            "router_age": round(time.time() - ROUTER_DB.stat().st_mtime, 0) if ROUTER_DB.exists() else None,
            "collector_age": round(time.time() - DATA_FILE.stat().st_mtime, 0) if DATA_FILE.exists() else None,
            "qoder_age": round(time.time() - QODER_DB.stat().st_mtime, 0) if QODER_DB.exists() else None,
            "sources": [
                {"key": "router", "label": "9router", "path": str(ROUTER_DB), "status": "ok" if ROUTER_DB.exists() else "missing"},
                {"key": "qoder", "label": "Qoder Desktop", "path": str(QODER_DB), "status": "ok" if QODER_DB.exists() else "missing"},
                {"key": "collector", "label": "Coletor local", "path": str(DATA_FILE), "status": "ok" if DATA_FILE.exists() else "missing"},
            ],
            "privacy": [
                "Nenhuma chave, token OAuth ou senha é lida para a interface.",
                "Prompts e trechos de código não são persistidos nem enviados.",
                "Apenas metadados derivados: provedor, modelo, tokens, custo, status e horário.",
                "Servidor escuta só em 127.0.0.1 e abre os bancos em modo somente-leitura.",
            ],
        },
        "series": days,
        "month": router.get("month") or {},
        "settings": settings_view,
        "hours": router.get("hours", {}),
        "totals": {
            "tokens": total_tokens, "cost": total_cost, "requests": total_req,
            "cached": total_cached, "input": total_input,
            "cacheHit": _pct(total_cached, total_input),
            "activeDays": len(active_days),
            "avgTokens": round(avg, 0), "avgCost": round(cost_avg, 4),
        },
        "today": today,
        "providers": router["providers"],
        "models": router["models"][:18],
        "slo": router.get("slo") or {"providers": [], "overall": {}, "window": "7d"},
        "recent": router["recent"],
        "errors": errors,
        "alerts": alerts,
        "connections": connections,
        "fleet": fleet,
        "keys": keys,
        "quota": quota,
        "sunStates": sun_states,
        "router": {
            "headroom": {"enabled": bool(router_cfg.get("headroomEnabled")), "online": bool(router_cfg.get("headroom_online")), "url": router_cfg.get("headroomUrl")},
            "fallback": router_cfg.get("fallbackStrategy"),
            "tunnel": bool(router_cfg.get("tunnelEnabled")),
            "caveman": router_cfg.get("cavemanLevel"),
            "ponytail": router_cfg.get("ponytailLevel"),
            "combos": [{"name": c.get("name"), "models": len(c.get("models") or []), "kind": c.get("kind") or "combo"} for c in data.get("combos") or []],
            "links": [
                {"label": "Abrir 9router", "url": "http://127.0.0.1:20128", "hint": "painel local"},
                {"label": "Painel anterior", "url": "http://127.0.0.1:8765", "hint": "ai-usage"},
                {"label": "Headroom", "url": "http://127.0.0.1:8787", "hint": "compressor local"},
            ],
        },
        "projects": projects,
        "suggestions": suggestions,
        "inventory": {
            "clis": [{"name": c.get("name"), "installed": bool(c.get("installed"))} for c in inventory.get("clis") or []],
            "apps": [{"name": a.get("name"), "installed": bool(a.get("installed"))} for a in inventory.get("apps") or []],
            "codex": {"installed": bool(codex_inv.get("installed")), "model": codex_inv.get("model"), "plugins": int(codex_inv.get("plugins_total") or 0), "pluginsEnabled": int(codex_inv.get("plugins_enabled") or 0), "mcp": len(codex_inv.get("mcp") or [])},
            "qoder": {"installed": bool(qoder_inv.get("installed")), "plugins": int(qoder_inv.get("plugins_total") or 0), "pluginsEnabled": int(qoder_inv.get("plugins_enabled") or 0)},
        },
        "qoder": qoder,
        "insights": {
            "topProvider": top_provider,
            "topModel": top_model,
            "mostExpensive": most_expensive,
            "todayVsAvg": round(today.get("tokens", 0) / avg, 1) if avg else 0,
            "todayVsPrev": round(today.get("tokens", 0) / prev.get("tokens", 1), 1) if prev and prev.get("tokens") else 0,
            "costPerReq": round(today.get("cost", 0) / today.get("requests", 1), 4) if today.get("requests") else 0,
            "freeTokensEstimate": round((codex_q.get("week_free") or 0) / 100 * 6_400_000),
        },
    }


def _escape_label(value) -> str:
    return str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def _metric(lines: list[str], name: str, kind: str, help_text: str, samples: list[tuple[dict | None, float | int]]) -> None:
    lines.append(f"# HELP {name} {help_text}")
    lines.append(f"# TYPE {name} {kind}")
    for labels, value in samples:
        tag = ""
        if labels:
            tag = "{" + ",".join(f'{k}="{_escape_label(v)}"' for k, v in labels.items()) + "}"
        lines.append(f"{name}{tag} {value}")


def prometheus_metrics() -> str:
    snap = build_snapshot()
    today = snap.get("today") or {}
    totals = snap.get("totals") or {}
    meta = snap.get("meta") or {}
    quota = snap.get("quota") or {}
    slo = snap.get("slo") or {}
    lines: list[str] = []

    _metric(lines, "rune_up", "gauge", "Rune local collector reachable.", [(None, 1)])
    _metric(lines, "rune_snapshot_timestamp_seconds", "gauge", "Unix time of this snapshot.", [(None, int(time.time()))])
    _metric(lines, "rune_tokens_today", "gauge", "Tokens consumed today.", [(None, int(today.get("tokens") or 0))])
    _metric(lines, "rune_requests_today", "gauge", "Requests made today.", [(None, int(today.get("requests") or 0))])
    _metric(lines, "rune_cost_today_usd", "gauge", "Estimated cost today in USD (9router base).", [(None, round(float(today.get("cost") or 0), 6))])
    month = snap.get("month") or {}
    if month:
        _metric(lines, "rune_month_cost_usd", "gauge", "Estimated cost in the current month in USD (9router base).",
                [(None, round(float(month.get("cost") or 0), 6))])
        _metric(lines, "rune_month_projected_usd", "gauge", "Projected cost for the current month in USD.",
                [(None, round(float(month.get("projected") or 0), 6))])
    budget = (snap.get("settings") or {}).get("budgets") or {}
    if budget.get("global"):
        _metric(lines, "rune_budget_global_usd", "gauge", "Configured monthly budget in USD.",
                [(None, round(float(budget["global"]), 2))])
    _metric(lines, "rune_cache_hit_ratio", "gauge", "Share of input tokens served from cache (0-1).", [(None, round(float(totals.get("cacheHit") or 0) / 100, 4))])
    _metric(lines, "rune_errors_open", "gauge", "Grouped error diagnostics in the window.", [(None, len(snap.get("errors") or []))])
    for key in ("router_age", "collector_age", "qoder_age"):
        if meta.get(key) is not None:
            _metric(lines, f"rune_{key}_seconds", "gauge", f"Age of {key.replace('_', ' ')} in seconds.", [(None, meta[key])])

    _metric(lines, "rune_provider_tokens", "gauge", "Tokens per provider in the window.",
            [({"provider": p.get("provider")}, int(p.get("tokens") or 0)) for p in snap.get("providers") or []])
    _metric(lines, "rune_provider_requests", "gauge", "Requests per provider in the window.",
            [({"provider": p.get("provider")}, int(p.get("requests") or 0)) for p in snap.get("providers") or []])
    _metric(lines, "rune_provider_cost_usd", "gauge", "Estimated cost per provider in USD (9router base).",
            [({"provider": p.get("provider")}, round(float(p.get("cost") or 0), 6)) for p in snap.get("providers") or []])
    _metric(lines, "rune_provider_share_ratio", "gauge", "Token share per provider (0-1).",
            [({"provider": p.get("provider")}, round(float(p.get("share") or 0) / 100, 4)) for p in snap.get("providers") or []])

    slo_rows = [p for p in slo.get("providers") or [] if p.get("requests")]
    _metric(lines, "rune_provider_p50_latency_ms", "gauge", "Median end-to-end latency per provider (7d).",
            [({"provider": p.get("provider")}, p.get("p50") or 0) for p in slo_rows])
    _metric(lines, "rune_provider_p95_latency_ms", "gauge", "p95 end-to-end latency per provider (7d).",
            [({"provider": p.get("provider")}, p.get("p95") or 0) for p in slo_rows])
    _metric(lines, "rune_provider_ttft_p50_ms", "gauge", "Median time to first token per provider (7d).",
            [({"provider": p.get("provider")}, p.get("ttftP50") or 0) for p in slo_rows])
    _metric(lines, "rune_provider_error_ratio", "gauge", "Error share per provider (0-1).",
            [({"provider": p.get("provider")}, round(float(p.get("errorRate") or 0) / 100, 4)) for p in slo_rows])

    _metric(lines, "rune_model_tokens", "gauge", "Tokens per model (top models).",
            [({"provider": m.get("provider"), "model": m.get("model")}, int(m.get("tokens") or 0)) for m in (snap.get("models") or [])[:15]])

    for key in ("codex", "claude"):
        q = quota.get(key) or {}
        if q.get("available") and q.get("week_free") is not None:
            _metric(lines, f"rune_{key}_week_free_ratio", "gauge", f"{key} weekly headroom (0-1).",
                    [(None, round(float(q["week_free"]) / 100, 4))])
    codex_q = quota.get("codex") or {}
    if codex_q.get("available") and codex_q.get("session_free") is not None:
        _metric(lines, "rune_codex_session_free_ratio", "gauge", "Codex 5h window headroom (0-1).",
                [(None, round(float(codex_q["session_free"]) / 100, 4))])

    return "\n".join(lines) + "\n"


def _file_mode(path: Path) -> str | None:
    try:
        return format(path.stat().st_mode & 0o777, "03o")
    except OSError:
        return None


def _mode_exposed(mode: str | None, want_group: bool = False) -> bool:
    if not mode:
        return False
    group = int(mode[-2]) if len(mode) >= 2 else 0
    other = int(mode[-1]) if mode else 0
    return other != 0 or (want_group and group != 0)


def _count_secrets(path: Path) -> int:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return 0
    return len(SECRET_RE.findall(text))


def security_audit() -> dict:
    """Checagens somente-leitura do ambiente local. Nunca devolve segredos."""
    data = _read_json(DATA_FILE)
    settings = data.get("router_settings") or {}
    findings: list[dict] = []
    checks: list[dict] = []

    def check(key: str, label: str, ok: bool, detail: str, params: dict | None = None) -> None:
        checks.append({"key": key, "label": label, "ok": ok, "detail": detail, "params": params or {}})

    def finding(level: str, code: str, title: str, detail: str, fix: str = "", params: dict | None = None) -> None:
        findings.append({"level": level, "code": code, "title": title, "detail": detail, "fix": fix, "params": params or {}})

    loopback = HOST in ("127.0.0.1", "localhost", "::1")
    check("bind", "Servidor só em 127.0.0.1", loopback,
          f"escuta em {HOST}:{PORT}" if loopback else f"exposto em {HOST}:{PORT}",
          {"endpoint": f"{HOST}:{PORT}"})
    if not loopback:
        finding("bad", "bind_exposed", "Servidor exposto na rede",
                f"O Rune está escutando em {HOST}:{PORT}. Isso permite que outras máquinas leiam seus metadados.",
                f"RUNE_HOST=127.0.0.1 python3 {BASE / 'server.py'}", {"endpoint": f"{HOST}:{PORT}"})

    targets = [
        ("collector", "coletor", DATA_FILE, True),
        ("collector_config", "config do coletor", AI_USAGE / "config.json", True),
        ("collector_dir", "diretório do coletor", AI_USAGE, False),
        ("router_db", "banco do 9router", ROUTER_DB, True),
        ("qoder_db", "banco do Qoder", QODER_DB, True),
    ]
    perms_bad = []
    for target, label, path, is_file in targets:
        if not path.exists():
            continue
        mode = _file_mode(path)
        exposed = _mode_exposed(mode, want_group=not is_file)
        perms_bad.append({"target": target, "label": label, "path": path, "mode": mode, "exposed": exposed})
        if exposed:
            want = 600 if is_file else 700
            finding("warn", "perm", f"{label[0].upper()}{label[1:]} legível por outros usuários",
                    f"{path.name} está com permissão {mode}. Outros usuários locais conseguem ler metadados e credenciais.",
                    f"chmod {want} '{path}'",
                    {"target": target, "name": path.name, "mode": mode, "want": want})
    check("perms", "Arquivos locais restritos ao seu usuário",
          not any(p["exposed"] for p in perms_bad),
          ", ".join(f"{p['label']} {p['mode']}" for p in perms_bad) or "nenhum arquivo encontrado",
          {"list": ", ".join(f"{p['label']} {p['mode']}" for p in perms_bad),
           "modes": {p["target"]: p["mode"] for p in perms_bad}})

    scan_targets = [DATA_FILE, AI_USAGE / "config.json"]
    hits = {str(p): _count_secrets(p) for p in scan_targets if p.exists()}
    total_hits = sum(hits.values())
    check("secrets", "Nenhum segredo nos arquivos do coletor", total_hits == 0,
          "varredura por sk-, Bearer, ya29 e sk-ant" + (f" · {total_hits} achado(s)" if total_hits else ""),
          {"hits": total_hits})
    if total_hits:
        finding("bad", "secret_text", "Segredo em texto no coletor",
                f"{total_hits} padrão(ões) de chave encontrados em arquivos JSON do coletor. O valor nunca é exibido, mas o arquivo deve ser limpo e restrito.",
                f"chmod 600 '{DATA_FILE}' && grep -nE 'sk-|Bearer|ya29|sk-ant' '{DATA_FILE}'",
                {"n": total_hits})

    active_keys = [k for k in data.get("keys") or [] if k.get("active")]
    restricted = [k for k in active_keys if k.get("restricted")]
    tunnel = bool(settings.get("tunnelEnabled"))
    tunnel_state = "active" if tunnel and active_keys else "off" if not tunnel else "nokey"
    check("tunnel", "Túnel do 9router protegido por chave", (not tunnel) or bool(active_keys),
          "túnel ativo · exigência de API key preservada" if tunnel_state == "active" else ("túnel desligado" if tunnel_state == "off" else "túnel ativo sem chave ativa"),
          {"state": tunnel_state})
    if tunnel and not active_keys:
        finding("bad", "tunnel_nokey", "Túnel ativo sem API key",
                "O 9router está exposto por túnel e nenhuma chave ativa foi encontrada. O Rune não altera essa proteção — reative uma chave no painel do 9router.",
                "Abra http://127.0.0.1:20128 e crie uma API key ativa.")
    elif tunnel and len(restricted) < len(active_keys):
        finding("warn", "tunnel_restrict", "Chave sem restrição com túnel ativo",
                f"{len(active_keys) - len(restricted)} chave(s) ativa(s) sem restrição de modelos. Com o túnel ligado, uma chave vazada alcança toda a frota.",
                "No painel do 9router, marque restrição de modelos/rotas nas chaves usadas pelo túnel.",
                {"n": len(active_keys) - len(restricted)})
    elif tunnel:
        finding("info", "tunnel_info", "Túnel do 9router ativo",
                "A exposição via Cloudflare continua protegida pela API key do 9router. O Rune não remove nem contorna essa exigência.",
                "Mantenha a chave restrita e rotacione se houver suspeita de vazamento.")

    check("readonly", "Bancos abertos em modo somente-leitura", True,
          "9router e Qoder via file:...?mode=ro")
    check("mask", "Credenciais nunca exibidas", True,
          "chaves só por keyId; e-mails e segredos são mascarados")
    check("redact", "Prompts e código fora do coletor", True,
          "apenas provedor, modelo, tokens, custo, status e horário")

    penalty = {"bad": 25, "warn": 12, "info": 3}
    score = max(0, 100 - sum(penalty.get(f["level"], 0) for f in findings))
    level = "ok" if score >= 90 else "warn" if score >= 50 else "bad"
    order = {"bad": 0, "warn": 1, "info": 2}
    findings.sort(key=lambda f: order.get(f["level"], 3))

    return {
        "ok": True,
        "score": score,
        "level": level,
        "findings": findings,
        "checks": checks,
        "checked_at": datetime.now().astimezone().isoformat(),
    }


_metrics_lock = threading.Lock()
_metrics_cache: dict = {"at": 0.0, "body": ""}
try:
    METRICS_TTL = max(0.0, float(os.environ.get("RUNE_METRICS_TTL", "20")))
except ValueError:
    METRICS_TTL = 20.0


def metrics_body() -> str:
    """Prometheus bate a cada 15 s; o snapshot é caro, então o corpo é reaproveitado por alguns segundos."""
    now = time.time()
    with _metrics_lock:
        if _metrics_cache["body"] and now - _metrics_cache["at"] < METRICS_TTL:
            return _metrics_cache["body"]
    body = prometheus_metrics()
    with _metrics_lock:
        _metrics_cache.update({"at": now, "body": body})
    return body


class Handler(BaseHTTPRequestHandler):
    server_version = "rune-live/0.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, status: int, body: bytes, ctype: str, headers: dict[str, str] | None = None):
        headers = headers or {}
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if "Cache-Control" not in headers:
            self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, status: int, payload: dict):
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            self._file(BASE / "index.html", "text/html; charset=utf-8")
        elif path == "/styles.css":
            self._file(BASE / "styles.css", "text/css; charset=utf-8")
        elif path == "/app.js":
            self._file(BASE / "app.js", "text/javascript; charset=utf-8")
        elif path == "/i18n.js":
            self._file(BASE / "i18n.js", "text/javascript; charset=utf-8")
        elif path.startswith("/assets/"):
            target = (BASE / path.lstrip("/")).resolve()
            if BASE not in target.parents and target.parent != BASE:
                self._json(404, {"error": "rota inexistente"})
                return
            ctype = "image/png" if target.suffix.lower() == ".png" else "application/octet-stream"
            self._file(target, ctype)
        elif path == "/api/snapshot":
            try:
                self._json(200, build_snapshot())
            except Exception as exc:  # noqa: BLE001
                self._json(500, {"error": "falha ao montar snapshot", "detail": _clean(str(exc), 200)})
        elif path == "/api/health":
            self._json(200, {"ok": True, "pid": os.getpid(), "port": PORT})
        elif path == "/api/fleet":
            try:
                fleet = {**router_catalog(force=True), "routes": fleet_routes()}
                self._json(200, fleet)
            except Exception as exc:  # noqa: BLE001
                self._json(500, {"online": False, "error": "falha ao listar a frota", "detail": _clean(str(exc), 160)})
        elif path == "/api/settings":
            self._json(200, {"ok": True, **public_settings()})
        elif path == "/api/export.csv":
            month = (parse_qs(urlparse(self.path).query).get("month") or [""])[0]
            try:
                resolved, body = accounting_csv(month)
            except Exception as exc:  # noqa: BLE001
                self._json(500, {"ok": False, "error": "falha ao exportar", "detail": _clean(str(exc), 160)})
                return
            self._send(
                200, body.encode("utf-8"), "text/csv; charset=utf-8",
                {"Content-Disposition": f'attachment; filename="rune-{resolved}.csv"'},
            )
        elif path == "/api/security":
            try:
                self._json(200, security_audit())
            except Exception as exc:  # noqa: BLE001
                self._json(500, {"ok": False, "error": "falha na auditoria", "detail": _clean(str(exc), 200)})
        elif path == "/metrics":
            try:
                body = metrics_body().encode("utf-8")
            except Exception as exc:  # noqa: BLE001
                self._json(500, {"error": "falha ao gerar métricas", "detail": _clean(str(exc), 200)})
                return
            self._send(200, body, "text/plain; version=0.0.4; charset=utf-8")
        else:
            self._json(404, {"error": "rota inexistente"})

    def _same_origin(self) -> bool:
        """Bloqueia POST disparado por outra página aberta no navegador (CSRF em loopback)."""
        return _origin_matches(self.headers.get("Origin") or "", self.headers.get("Host") or "")

    def do_POST(self):
        path = urlparse(self.path).path
        if not self._same_origin():
            self._json(403, {"ok": False, "error": "origem não permitida"})
            return
        if path == "/api/refresh":
            if not _refresh_lock.acquire(blocking=False):
                self._json(409, {"ok": False, "error": "coleta já em andamento"})
                return
            try:
                if not COLLECT.exists():
                    self._json(404, {"ok": False, "error": "collect.py não encontrado"})
                    return
                started = time.time()
                try:
                    env = {**os.environ, "AI_USAGE_HOME": str(AI_USAGE)}
                    proc = subprocess.run([sys.executable, str(COLLECT), "--quiet"], cwd=str(COLLECT.parent),
                                          capture_output=True, text=True, timeout=90, env=env)
                except subprocess.TimeoutExpired:
                    self._json(504, {"ok": False, "error": "coleta excedeu 90s"})
                    return
                if proc.returncode != 0:
                    tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-4:]
                    self._json(500, {"ok": False, "error": "collect.py falhou", "detail": "\n".join(tail)})
                    return
                self._json(200, {"ok": True, "seconds": round(time.time() - started, 1), "snapshot": build_snapshot()})
            finally:
                _refresh_lock.release()
        elif path == "/api/probe":
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length > 4096:
                self._json(413, {"ok": False, "error": "payload grande demais"})
                return
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                self._json(400, {"ok": False, "error": "json inválido"})
                return
            model = str(payload.get("model") or "").strip()
            connection = str(payload.get("connection") or "").strip()
            try:
                if model:
                    self._json(200, probe_route(model))
                elif connection:
                    self._json(200, probe_connection(connection, force=bool(payload.get("force"))))
                elif payload.get("all"):
                    self._json(200, {"results": probe_all()})
                else:
                    self._json(400, {"ok": False, "error": "informe model, connection ou all"})
            except Exception as exc:  # noqa: BLE001
                self._json(500, {"ok": False, "model": model, "connection": connection,
                                 "error": _clean(f"{type(exc).__name__}: {exc}", 160)})
        elif path == "/api/settings":
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length > 16384:
                self._json(413, {"ok": False, "error": "payload grande demais"})
                return
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                self._json(400, {"ok": False, "error": "json inválido"})
                return
            if not isinstance(payload, dict):
                self._json(400, {"ok": False, "error": "json inválido"})
                return
            current = load_settings()
            budgets = payload.get("budgets")
            if isinstance(budgets, dict):
                for key in ("global", "providers", "threshold"):
                    if key in budgets:
                        current["budgets"][key] = budgets[key]
            alerts = payload.get("alerts")
            if isinstance(alerts, dict):
                for key in ("macos", "webhook", "cooldown_min"):
                    if key in alerts:
                        current["alerts"][key] = alerts[key]
                if alerts.get("webhook_clear"):
                    current["alerts"]["webhook"] = ""
            try:
                save_settings(current)
            except OSError as exc:
                self._json(500, {"ok": False, "error": "não foi possível salvar", "detail": _clean(str(exc), 160)})
                return
            self._json(200, {"ok": True, **public_settings()})
        else:
            self._json(404, {"error": "rota inexistente"})

    def _file(self, path: Path, ctype: str):
        try:
            stat = path.stat()
        except OSError:
            self._json(404, {"error": "arquivo não encontrado"})
            return
        etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return
        try:
            body = path.read_bytes()
        except OSError:
            self._json(404, {"error": "arquivo não encontrado"})
            return
        self._send(200, body, ctype, {"ETag": etag, "Cache-Control": "no-cache"})


def main() -> int:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    start_alert_watcher()
    print(f"Rune Live em http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
