#!/usr/bin/env python3
"""Coleta consumo e inventario de IAs em data.json (somente leitura)."""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path.home()
BASE = Path(os.environ.get("AI_USAGE_HOME") or Path(__file__).resolve().parent).expanduser().resolve()
BASE.mkdir(parents=True, exist_ok=True)
ROUTER_DB = HOME / ".9router/db/data.sqlite"
CODEX_CONFIG = HOME / ".codex/config.toml"
QODER_SETTINGS = HOME / ".qoder/settings.json"
QODER_MCP = HOME / ".qoder/mcp-router.json"
QODER_PROJECTS = HOME / ".qoder/projects"
PROJETOS = HOME / "Projetos"
DATA_FILE = BASE / "data.json"
CONFIG_FILE = BASE / "config.json"

DEFAULT_CONFIG = {
    "daily_target_percent_override": None,
    "alert_percent": 80,
    "preferred_models": {
        "codigo": "gpt-6.1-sol (Codex) para tarefas dificeis",
        "texto": "deepseek/deepseek-v3.2 (OpenRouter) para volume",
        "pesquisa": "gemini-3.8-flash (Antigravity) para pesquisa",
        "gratis": "openrouter/openrouter/free ou nvidia/nemotron-3-ultra",
    },
}

CLI_CANDIDATES = [
    ("codex", "Codex CLI"),
    ("claude", "Claude Code"),
    ("gemini", "Gemini CLI"),
    ("agy", "Antigravity CLI"),
    ("qoder", "Qoder CLI"),
    ("ollama", "Ollama"),
    ("opencode", "OpenCode"),
    ("crush", "Crush"),
    ("aider", "Aider"),
    ("cursor-agent", "Cursor Agent"),
    ("goose", "Goose"),
    ("amp", "Amp"),
]

APP_CANDIDATES = [
    ("ChatGPT / Codex", "ChatGPT.app"),
    ("Qoder", "Qoder.app"),
    ("Claude", "Claude.app"),
    ("Antigravity", "Antigravity.app"),
    ("Orca", "Orca.app"),
    ("Cursor", "Cursor.app"),
    ("Ollama", "Ollama.app"),
]


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def iso_utc(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value else None


def connect_db() -> sqlite3.Connection | None:
    if not ROUTER_DB.exists():
        return None
    con = sqlite3.connect(f"file:{ROUTER_DB}?mode=ro", uri=True, timeout=5)
    con.row_factory = sqlite3.Row
    return con


def load_router_settings(con) -> dict:
    try:
        row = con.execute("select data from settings limit 1").fetchone()
        return json.loads(row["data"]) if row else {}
    except Exception:
        return {}


def headroom_online(url: str) -> bool:
    if not url:
        return False
    try:
        req = urllib.request.Request(url.rstrip("/") + "/v1/compress", method="GET")
        with urllib.request.urlopen(req, timeout=1.5):
            return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False


def collect_usage(con, days: int = 120) -> dict:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    by_day: dict[str, dict] = defaultdict(lambda: {
        "requests": 0, "input": 0, "cached": 0, "output": 0,
        "reasoning": 0, "cost": 0.0,
    })
    by_model: dict[tuple[str, str], dict] = defaultdict(lambda: {
        "requests": 0, "input": 0, "cached": 0, "output": 0, "cost": 0.0,
    })
    by_provider: dict[str, dict] = defaultdict(lambda: {
        "requests": 0, "input": 0, "cached": 0, "output": 0, "cost": 0.0,
    })
    recent: list[dict] = []

    rows = con.execute(
        "select timestamp, provider, model, promptTokens, completionTokens, cost, status, tokens "
        "from usageHistory order by timestamp desc limit 20000"
    ).fetchall()

    for row in rows:
        ts = parse_iso(row["timestamp"])
        if not ts or ts < cutoff:
            continue
        try:
            tok = json.loads(row["tokens"] or "{}")
        except Exception:
            tok = {}
        inp = int(row["promptTokens"] or 0)
        out = int(row["completionTokens"] or 0)
        cached = int(tok.get("cached_tokens") or 0)
        reasoning = int(tok.get("reasoning_tokens") or 0)
        cost = float(row["cost"] or 0)
        local = ts.astimezone()
        day = local.strftime("%Y-%m-%d")
        provider = row["provider"] or "?"
        model = row["model"] or "?"

        for bucket in (by_day[day], by_model[(provider, model)], by_provider[provider]):
            bucket["requests"] += 1
            bucket["input"] += inp
            bucket["cached"] += cached
            bucket["output"] += out
            bucket["cost"] += cost
        by_day[day]["reasoning"] += reasoning

        if len(recent) < 80:
            recent.append({
                "timestamp": iso_utc(ts),
                "time": local.strftime("%d/%m %H:%M"),
                "provider": provider,
                "model": model,
                "input": inp,
                "cached": cached,
                "output": out,
                "cost": cost,
                "status": row["status"] or "?",
            })

    days_list = [dict(date=d, **v) for d, v in sorted(by_day.items())]
    models = [
        dict(provider=p, model=m, **v)
        for (p, m), v in sorted(by_model.items(), key=lambda x: -(x[1]["input"] + x[1]["output"]))
    ]
    providers = [
        dict(provider=p, **v)
        for p, v in sorted(by_provider.items(), key=lambda x: -(x[1]["input"] + x[1]["output"]))
    ]
    totals = {
        "requests": sum(d["requests"] for d in days_list),
        "input": sum(d["input"] for d in days_list),
        "cached": sum(d["cached"] for d in days_list),
        "output": sum(d["output"] for d in days_list),
        "cost": round(sum(d["cost"] for d in days_list), 6),
    }
    return {"days": days_list, "models": models, "providers": providers,
            "recent": recent, "totals": totals}


def collect_connections(con) -> list[dict]:
    out = []
    for row in con.execute(
        "select provider, name, email, authType, isActive, data from providerConnections"
    ):
        try:
            d = json.loads(row["data"])
        except Exception:
            d = {}
        specific = d.get("providerSpecificData") or {}
        out.append({
            "provider": row["provider"],
            "name": row["name"] or row["provider"],
            "email": row["email"] or "",
            "auth": row["authType"] or "",
            "active": bool(row["isActive"]),
            "status": d.get("testStatus") or "unknown",
            "plan": specific.get("chatgptPlanType") or "",
            "error": (d.get("lastError") or "")[:180],
            "errorCode": d.get("errorCode"),
            "lastUsedAt": d.get("lastUsedAt"),
            "expiresAt": d.get("expiresAt"),
        })
    return out


def collect_combos(con) -> list[dict]:
    out = []
    try:
        for row in con.execute("select name, kind, models from combos order by name"):
            try:
                models = json.loads(row["models"] or "[]")
            except Exception:
                models = []
            out.append({
                "name": row["name"],
                "kind": row["kind"] or "",
                "models": models,
            })
    except Exception:
        pass
    return out


def collect_keys(con) -> list[dict]:
    out = []
    try:
        for row in con.execute("select name, key, isActive, accessRestricted, createdAt from apiKeys"):
            parts = (row["key"] or "").split("-")
            key_id = parts[2] if len(parts) == 4 else (parts[-1] if parts else "")
            out.append({
                "name": row["name"] or "(sem nome)",
                "keyId": key_id,
                "active": bool(row["isActive"]),
                "restricted": bool(row["accessRestricted"]),
                "createdAt": row["createdAt"],
            })
    except Exception:
        pass
    return out


def _window(w: dict | None) -> dict | None:
    if not w:
        return None
    reset_at = w.get("reset_at")
    reset = datetime.fromtimestamp(reset_at, tz=timezone.utc) if reset_at else None
    reset_after = w.get("reset_after_seconds") or 0
    return {
        "used_percent": w.get("used_percent"),
        "window_seconds": w.get("limit_window_seconds"),
        "reset_at": iso_utc(reset),
        "reset_after_seconds": reset_after,
        "days_left": round(reset_after / 86400, 2) if reset_after else None,
    }


def codex_quota(con) -> dict:
    try:
        row = con.execute("select data from providerConnections where provider='codex' limit 1").fetchone()
        if not row:
            return {"available": False, "error": "sem conexao codex"}
        d = json.loads(row["data"])
        token = d.get("accessToken")
        account = (d.get("providerSpecificData") or {}).get("chatgptAccountId", "")
        req = urllib.request.Request(
            "https://chatgpt.com/backend-api/wham/usage",
            headers={
                "Authorization": "Bearer " + token,
                "chatgpt-account-id": account,
                "originator": "codex_cli_rs",
                "User-Agent": "codex_cli_rs/0.159.0",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            j = json.loads(resp.read().decode())
        rl = j.get("rate_limit") or {}
        primary = _window(rl.get("primary_window"))
        weekly = _window(rl.get("secondary_window"))
        budget = {}
        if weekly and weekly.get("used_percent") is not None:
            used = float(weekly["used_percent"])
            window = weekly.get("window_seconds") or 604800
            left = float(weekly.get("reset_after_seconds") or 0)
            elapsed = max(window - left, 1) / 86400
            days_left = max(left / 86400, 1e-6)
            budget = {
                "remaining_percent": round(100 - used, 1),
                "elapsed_days": round(elapsed, 2),
                "daily_target_percent": round((100 - used) / days_left, 1),
                "pace_percent_per_day": round(used / elapsed, 1),
            }
        return {
            "available": True,
            "plan": j.get("plan_type"),
            "allowed": rl.get("allowed"),
            "limit_reached": rl.get("limit_reached"),
            "primary": primary,
            "weekly": weekly,
            "budget": budget,
            "credits": j.get("credits") or {},
            "reset_credits": (j.get("rate_limit_reset_credits") or {}).get("available_count", 0),
            "email": j.get("email"),
        }
    except Exception as exc:
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"}


def claude_quota(con) -> dict:
    try:
        row = con.execute("select data from providerConnections where provider='claude' limit 1").fetchone()
        if not row:
            return {"available": False, "error": "sem conexao claude"}
        d = json.loads(row["data"])
        token = d.get("accessToken")
        req = urllib.request.Request(
            "https://api.anthropic.com/api/oauth/usage",
            headers={
                "Authorization": "Bearer " + token,
                "anthropic-beta": "oauth-2025-04-20",
                "User-Agent": "claude-cli/2.1.280 (external, sdk-cli)",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            j = json.loads(resp.read().decode())
        return {"available": True, "raw": j}
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            return {"available": False, "error": "HTTP 401 (token expirado; o 9router renova ao usar o Claude)"}
        return {"available": False, "error": f"HTTP {exc.code}"}
    except Exception as exc:
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"}


def collect_clis() -> list[dict]:
    out = []
    for cmd, label in CLI_CANDIDATES:
        path = shutil.which(cmd)
        if not path:
            continue
        version = ""
        try:
            proc = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=5)
            text = (proc.stdout or proc.stderr or "").strip()
            version = text.splitlines()[0][:90] if text else ""
        except Exception:
            version = ""
        out.append({"id": cmd, "name": label, "path": path, "version": version})
    return out


def collect_apps() -> list[dict]:
    out = []
    for name, bundle in APP_CANDIDATES:
        path = Path("/Applications") / bundle
        if path.exists():
            out.append({"name": name, "path": str(path)})
    return out


def collect_codex() -> dict:
    if not CODEX_CONFIG.exists():
        return {"installed": False}
    try:
        cfg = tomllib.loads(CODEX_CONFIG.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"installed": True, "error": str(exc)}
    plugins = cfg.get("plugins", {})
    enabled = [k for k, v in plugins.items() if isinstance(v, dict) and v.get("enabled")]
    groups = Counter(k.split("@")[-1] for k in enabled)
    mcp = []
    for name, value in (cfg.get("mcp_servers") or {}).items():
        target = value.get("url") or value.get("command") or ""
        mcp.append({"name": name, "target": target, "type": "url" if value.get("url") else "command"})
    return {
        "installed": True,
        "model": cfg.get("model"),
        "provider": cfg.get("model_provider"),
        "verbosity": cfg.get("model_verbosity"),
        "reasoning_effort": cfg.get("model_reasoning_effort"),
        "reasoning_summary": cfg.get("model_reasoning_summary"),
        "service_tier": cfg.get("service_tier"),
        "ambient_suggestions": (cfg.get("desktop") or {}).get("ambient-suggestions-enabled"),
        "generate_memories": (cfg.get("memories") or {}).get("generate_memories"),
        "plugins_total": len(plugins),
        "plugins_enabled": len(enabled),
        "plugin_groups": dict(groups),
        "plugins": enabled,
        "mcp": mcp,
        "projects_configured": list((cfg.get("projects") or {}).keys()),
    }


def collect_qoder() -> dict:
    settings = read_json(QODER_SETTINGS, {})
    plugins = settings.get("enabledPlugins", {})
    providers = []
    for pid, value in (settings.get("providers") or {}).items():
        providers.append({
            "id": pid,
            "baseUrl": value.get("baseUrl"),
            "model": value.get("model"),
            "type": value.get("type"),
        })
    router = read_json(QODER_MCP, {})
    return {
        "installed": True,
        "plugins_total": len(plugins),
        "plugins_enabled": sum(1 for v in plugins.values() if v),
        "provider_connections": providers,
        "mcp_router": bool(router.get("baseUrl")),
        "mcp_router_url": router.get("baseUrl"),
    }


def _markers(path: Path) -> tuple[list[str], list[str]]:
    markers: list[str] = []
    ais: list[str] = []
    files = {
        "AGENTS.md": "Codex",
        "CLAUDE.md": "Claude",
        "GEMINI.md": "Gemini",
        "mcp.json": "MCP",
        ".mcp.json": "MCP",
        ".cursorrules": "Cursor",
    }
    dirs = {
        ".codex": "Codex",
        ".claude": "Claude",
        ".qoder": "Qoder",
        ".cursor": "Cursor",
        ".gemini": "Gemini",
    }
    for name, ai in files.items():
        if (path / name).exists():
            markers.append(name)
            ais.append(ai)
    for name, ai in dirs.items():
        if (path / name).exists():
            markers.append(name + "/")
            ais.append(ai)
    return markers, sorted(set(ais))


def collect_projects() -> list[dict]:
    codex = collect_codex()
    configured = set(codex.get("projects_configured") or [])
    workspaces: dict[str, int] = {}
    for f in QODER_PROJECTS.glob("*/*.jsonl"):
        try:
            with f.open(encoding="utf-8", errors="ignore") as fh:
                first = json.loads(fh.readline())
        except Exception:
            continue
        for directory in first.get("directories", []):
            workspaces[directory] = workspaces.get(directory, 0) + 1

    paths: dict[str, str] = {}
    for p in configured:
        paths[p] = "codex"
    for p in workspaces:
        paths[p] = "qoder"
    if PROJETOS.exists():
        for child in sorted(PROJETOS.iterdir()):
            if child.is_dir() and not child.name.startswith("."):
                paths.setdefault(str(child), "projetos")

    out = []
    for raw, origin in paths.items():
        path = Path(raw)
        if not path.exists() or not path.is_dir():
            continue
        if "scratch-workspaces" in raw:
            continue
        markers, ais = _markers(path)
        if raw in configured and "Codex" not in ais:
            ais.append("Codex")
        if raw in workspaces and "Qoder" not in ais:
            ais.append("Qoder")
        try:
            mtime = path.stat().st_mtime
        except Exception:
            mtime = 0
        last = datetime.fromtimestamp(mtime).strftime("%d/%m/%Y") if mtime else ""
        if raw.startswith(str(PROJETOS)):
            kind = "projeto"
        elif raw.startswith(str(HOME / "Documents/Qoder")):
            kind = "workspace Qoder"
        else:
            kind = "outro"
        out.append({
            "path": raw,
            "name": path.name,
            "kind": kind,
            "origin": origin,
            "markers": markers,
            "ais": sorted(set(ais)),
            "sessions": workspaces.get(raw, 0),
            "last_activity": last,
        })
    out.sort(key=lambda x: (x["kind"] != "projeto", x["name"].lower()))
    return out


def build_budget(quota: dict, cfg: dict) -> dict:
    weekly = quota.get("weekly") or {}
    budget = dict(quota.get("budget") or {})
    override = cfg.get("daily_target_percent_override")
    if override:
        budget["daily_target_percent"] = float(override)
        budget["manual"] = True
    budget["alert_percent"] = cfg.get("alert_percent", 80)
    budget["used_percent"] = weekly.get("used_percent")
    budget["days_left"] = weekly.get("days_left")
    budget["reset_at"] = weekly.get("reset_at")
    return budget


def build_suggestions(data: dict, cfg: dict) -> list[dict]:
    out: list[dict] = []
    quota = data.get("quota", {}).get("codex", {})
    budget = quota.get("budget") or {}
    if quota.get("available"):
        pace = budget.get("pace_percent_per_day")
        target = budget.get("daily_target_percent")
        used = budget.get("used_percent")
        if target is not None and pace is not None:
            if pace > target * 1.15:
                out.append({
                    "level": "warn",
                    "title": "Ritmo acima da meta",
                    "detail": f"Voce esta usando {pace:.1f}%/dia da janela semanal; a meta ate o reset e {target:.1f}%/dia. Prefira modelos gratuitos ou DeepSeek nas tarefas simples.",
                })
            else:
                out.append({
                    "level": "ok",
                    "title": "Ritmo sob controle",
                    "detail": f"Ritmo de {pace:.1f}%/dia contra meta de {target:.1f}%/dia. Voce tem folga de {max(target - pace, 0):.1f} pontos por dia.",
                })
        if used is not None and used >= cfg.get("alert_percent", 80):
            out.append({
                "level": "danger",
                "title": "Janela semanal quase no limite",
                "detail": f"Ja foram usados {used:.0f}% da janela semanal. Segure o uso de GPT-6.1/Claude e migre para os combos baratos.",
            })
        primary = quota.get("primary") or {}
        if primary.get("used_percent") is not None and primary["used_percent"] >= 80:
            out.append({
                "level": "warn",
                "title": "Janela de 5h quase estourada",
                "detail": "A janela curta esta acima de 80%. Aguarde o reset antes de puxar tarefas pesadas.",
            })
        if (quota.get("credits") or {}).get("has_credits") is False:
            out.append({
                "level": "info",
                "title": "Sem creditos extras",
                "detail": "Seu plano nao tem saldo de credito adicional; o limite e a janela do plano. Reset credits disponiveis: %s." % quota.get("reset_credits", 0),
            })
    else:
        out.append({
            "level": "warn",
            "title": "Cota do Codex indisponivel",
            "detail": quota.get("error", "Nao foi possivel consultar a cota agora."),
        })

    for conn in data.get("connections", []):
        if conn.get("errorCode"):
            out.append({
                "level": "warn",
                "title": f"{conn['provider']} indisponivel ({conn['errorCode']})",
                "detail": conn.get("error") or "A conexao esta marcada com erro no 9router.",
            })

    settings = data.get("router_settings", {})
    if settings.get("headroomEnabled") and not settings.get("headroom_online"):
        out.append({
            "level": "warn",
            "title": "Headroom ligado mas offline",
            "detail": "O 9router tenta comprimir cada request e falha (localhost:8787). Ligue o Headroom ou desligue a opcao para remover essa tentativa por requisicao.",
        })
    if not settings.get("headroomEnabled"):
        out.append({
            "level": "info",
            "title": "Compressao de contexto desligada",
            "detail": "Ativar o Headroom pode reduzir o input por request. Vale ligar se voce usa sessoes longas.",
        })

    usage = data.get("usage", {})
    models = usage.get("models", [])
    total_cost = sum(m.get("cost", 0) for m in models) or 0
    if models and total_cost > 0:
        top = max(models, key=lambda m: m.get("cost", 0))
        share = top.get("cost", 0) / total_cost
        if share > 0.6 and top.get("output", 0) / max(top.get("requests", 1), 1) < 250:
            out.append({
                "level": "info",
                "title": "Modelo caro em tarefas leves",
                "detail": f"{top['model']} responde em media {top['output'] / max(top['requests'], 1):.0f} tokens de saida e concentra {share * 100:.0f}% do custo de referencia. Roteie tarefas simples para DeepSeek/OpenRouter.",
            })

    codex = data.get("inventory", {}).get("codex", {})
    if codex.get("plugins_enabled", 0) > 40:
        out.append({
            "level": "info",
            "title": "Muitos plugins no Codex",
            "detail": f"{codex['plugins_enabled']} plugins habilitados. Cada turno carrega instrucoes deles no contexto; desative os que nao usa para reduzir o input fixo.",
        })
    if codex.get("verbosity") == "high" or codex.get("reasoning_summary") == "detailed":
        out.append({
            "level": "info",
            "title": "Saida verbosa no Codex",
            "detail": "model_verbosity=high e reasoning_summary=detailed aumentam os tokens de saida. Para rotina, use low/auto.",
        })
    if codex.get("ambient_suggestions") or codex.get("generate_memories"):
        out.append({
            "level": "info",
            "title": "Chamadas em segundo plano ligadas",
            "detail": "Sugestoes ambientais e geracao de memorias fazem chamadas que consomem cota sem voce pedir. Desligue se nao usa.",
        })

    combos = data.get("combos", [])
    if combos:
        names = ", ".join(c["name"] for c in combos)
        out.append({
            "level": "info",
            "title": "Combos prontos no 9router",
            "detail": f"Voce tem {names}. Use os combos gratuitos/baratos como padrao e reserve o Codex para tarefas dificeis.",
        })

    order = {"danger": 0, "warn": 1, "info": 2, "ok": 3}
    out.sort(key=lambda s: order.get(s["level"], 9))
    return out


def print_report(data: dict) -> None:
    q = data["quota"]["codex"]
    print("\n=== AI USAGE ===")
    if q.get("available"):
        b = q.get("budget") or {}
        print(f"Plano: {q.get('plan')} ({q.get('email')})")
        print(f"Janela semanal: {b.get('used_percent')}% usada | {b.get('remaining_percent')}% livre | reset em {b.get('days_left')} dias")
        print(f"Meta diaria: {b.get('daily_target_percent')}%/dia | ritmo atual: {b.get('pace_percent_per_day')}%/dia")
        p = q.get("primary") or {}
        print(f"Janela 5h: {p.get('used_percent')}% usada | reset em {round((p.get('reset_after_seconds') or 0) / 60)} min")
        print(f"Creditos extras: {(q.get('credits') or {}).get('balance', '0')}")
    else:
        print("Cota do Codex indisponivel:", q.get("error"))

    totals = data["usage"]["totals"]
    print(f"\nConsumo medido (120d): {totals['requests']} chamadas | in {totals['input']:,} | out {totals['output']:,} | ref US$ {totals['cost']:.4f}")
    today = data["usage"]["days"][-1] if data["usage"]["days"] else None
    if today:
        print(f"Hoje ({today['date']}): {today['requests']} chamadas | in {today['input']:,} | out {today['output']:,} | ref US$ {today['cost']:.4f}")

    print("\nSugestoes:")
    for s in data["suggestions"][:8]:
        print(f"  [{s['level']}] {s['title']}: {s['detail']}")
    print()


def main() -> int:
    started = time.time()
    cfg = {**DEFAULT_CONFIG, **read_json(CONFIG_FILE, {})}
    con = connect_db()
    if not con:
        print(f"Banco do 9router nao encontrado em {ROUTER_DB}", file=sys.stderr)
        return 1

    settings = load_router_settings(con)
    quota_codex = codex_quota(con)
    data = {
        "generated_at": iso_utc(datetime.now(timezone.utc)),
        "generated_local": datetime.now().strftime("%d/%m/%Y %H:%M"),
        "duration_seconds": None,
        "sources": {
            "router_db": str(ROUTER_DB),
            "codex_config": str(CODEX_CONFIG),
            "qoder_settings": str(QODER_SETTINGS),
        },
        "quota": {
            "codex": quota_codex,
            "claude": claude_quota(con),
            "google": {"available": False, "error": "Google/Antigravity nao expoe cota por token; veja o painel do provedor."},
        },
        "usage": collect_usage(con),
        "connections": collect_connections(con),
        "combos": collect_combos(con),
        "keys": collect_keys(con),
        "router_settings": {
            "headroomEnabled": bool(settings.get("headroomEnabled")),
            "headroomUrl": settings.get("headroomUrl", ""),
            "headroom_online": headroom_online(settings.get("headroomUrl", "")),
            "cavemanLevel": settings.get("cavemanLevel"),
            "ponytailLevel": settings.get("ponytailLevel"),
            "fallbackStrategy": settings.get("fallbackStrategy"),
            "tunnelEnabled": bool(settings.get("tunnelEnabled")),
        },
        "inventory": {
            "clis": collect_clis(),
            "apps": collect_apps(),
            "codex": collect_codex(),
            "qoder": collect_qoder(),
        },
        "projects": collect_projects(),
    }
    data["quota"]["codex"]["budget"] = build_budget(quota_codex, cfg)
    data["suggestions"] = build_suggestions(data, cfg)
    data["duration_seconds"] = round(time.time() - started, 2)

    tmp = DATA_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, DATA_FILE)

    if "--report" in sys.argv:
        print_report(data)
    elif "--quiet" not in sys.argv:
        t = data["usage"]["totals"]
        print(f"ai-usage: dados atualizados em {data['duration_seconds']}s "
              f"({t['requests']} chamadas, {len(data['usage']['days'])} dias, "
              f"{len(data['projects'])} projetos) -> {DATA_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
