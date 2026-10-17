#!/usr/bin/env python3
"""Reference implementation of policy/{pairing,http,ids}.yaml, run against fixtures/{pairing,http,ids}/*.json.

SDKs must reproduce `parse_pairing`, `decide` and the id checks with identical results.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import parse_qsl, urlsplit

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
POLICY_DIR = ROOT / "policy"
FIXTURE_DIRS = [ROOT / "fixtures" / n for n in ("pairing", "http", "ids")]


def policy(name: str) -> dict:
    return yaml.safe_load((POLICY_DIR / f"{name}.yaml").read_text())


def host_matches(host: str, patterns: list[str]) -> bool:
    host = host.lower()
    return any(
        (host.endswith(p[1:]) and len(host) > len(p) - 1) if p.startswith("*.") else host == p
        for p in (q.lower() for q in patterns)
    )


def _err(code: str) -> dict:
    return {"result": "error", "code": code}


def _server_origin(value: str, srv: dict) -> dict:
    u = urlsplit(value if "://" in value else f"https://{value}")
    if u.scheme != "https" and srv["require_https"]:
        return _err("host_not_allowed")
    if (u.username or u.password) and not srv["allow_userinfo"]:
        return _err("host_not_allowed")
    try:
        port = u.port
    except ValueError:
        return _err("host_not_allowed")
    if port is not None and port not in srv["allowed_ports"]:
        return _err("host_not_allowed")
    if not u.hostname or not host_matches(u.hostname, srv["allowed_host_patterns"]):
        return _err("host_not_allowed")
    if u.path not in ("", "/") or u.query or u.fragment:
        return _err("invalid_input")
    return {"result": "ok", "host": f"https://{u.hostname.lower()}"}


def parse_pairing(link: str, pol: dict | None = None) -> dict:
    pol = pol or policy("pairing")
    u = urlsplit(link)
    form_ok = any(
        u.scheme == f["scheme"] and (u.hostname or "").lower() == f["authority"] and u.path.rstrip("/") == f["path"].rstrip("/")
        for f in pol["forms"]
    )
    if not form_ok or u.username or u.password or u.fragment:
        return _err("invalid_input")

    values: dict[str, list[str]] = {}
    for k, v in parse_qsl(u.query, keep_blank_values=True):
        values.setdefault(k, []).append(v)

    resolved = {}
    for field, spec in pol["params"].items():
        found = [v for n in [spec["canonical"], *spec["aliases"]] for v in values.get(n, [])]
        if len(set(found)) > 1:
            return _err("invalid_input")
        resolved[field] = found[0] if found else None

    code = resolved["code"]
    if code is None or not re.fullmatch(pol["params"]["code"]["regex"], code):
        return _err("invalid_input")
    host = resolved["host"] or pol["params"]["host"]["default"]
    out = _server_origin(host, pol["server"])
    if out["result"] != "ok":
        return out
    return {"result": "ok", "code": code, "host": out["host"]}


def _retry_after_ms(header: str | None, now: datetime, cap: int) -> int | None:
    if header is None:
        return None
    header = header.strip()
    if re.fullmatch(r"\d+", header):
        return min(int(header) * 1000, cap)
    try:
        when = parsedate_to_datetime(header)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    delta = int((when - now).total_seconds() * 1000)
    return min(delta, cap) if delta >= 0 else None


def _classify(outcome: str, pol: dict) -> dict:
    if outcome.startswith("status:"):
        status = int(outcome.split(":", 1)[1])
        if status in pol["statuses"]:
            return pol["statuses"][status]
        return pol["unmapped_status"]["4xx" if status < 500 else "5xx"]
    return pol["transport"][outcome]


def decide(inp: dict, pol: dict | None = None) -> dict:
    pol = pol or policy("http")
    cls = _classify(inp["outcome"], pol)
    max_attempts = pol["operations"][inp["operation"]]["max_attempts"]
    out = {"code": cls["code"], "retry": False}
    if cls["retry"] == "never" or inp["attempt"] + 1 >= max_attempts:
        return out
    if cls["retry"] == "ambiguous" and inp["method"].upper() not in pol["idempotent_methods"]:
        return out
    out["retry"] = True
    ra = pol["retry_after"]
    now = datetime.fromisoformat(inp.get("now", "2026-10-17T00:00:00+00:00"))
    hinted = _retry_after_ms(inp.get("retry_after"), now, ra["cap_ms"])
    if hinted is not None:
        out["delay_ms"] = hinted
    else:
        b = pol["backoff"]
        out["delay_max_ms"] = min(b["max_ms"], b["base_ms"] * b["multiplier"] ** inp["attempt"])
    return out


def check_id(kind: str, value: str, pol: dict | None = None) -> bool:
    pol = pol or policy("ids")
    if kind == "route_id":
        return re.fullmatch(pol["route_id"]["regex"], value) is not None
    if kind == "request_id":
        return any(re.fullmatch(a["regex"], value) for a in pol["request_id"]["accept"])
    raise KeyError(kind)


def run_case(kind: str, case: dict) -> dict:
    inp = case["input"]
    if kind == "pairing_parse":
        return parse_pairing(inp["link"])
    if kind == "http_decide":
        return decide(inp)
    if kind == "http_operation":
        return dict(policy("http")["operations"][inp["operation"]])
    if kind == "http_status":
        return {"code": _classify(inp["outcome"], policy("http"))["code"]}
    if kind == "id_check":
        return {"valid": check_id(inp["id_kind"], inp["value"])}
    raise KeyError(kind)


def fixture_files() -> list[pathlib.Path]:
    return sorted(f for d in FIXTURE_DIRS for f in d.glob("*.json"))


def covered_files() -> set[pathlib.Path]:
    return set(fixture_files())


def run_all() -> list[str]:
    failures = []
    for f in fixture_files():
        doc = json.loads(f.read_text())
        bad = 0
        for case in doc["cases"]:
            got = run_case(doc["kind"], case)
            if any(got.get(k) != v for k, v in case["expect"].items()):
                failures.append(f"{f.relative_to(ROOT)} [{case['name']}]: expected {case['expect']}, got {got}")
                bad += 1
        if not bad:
            print(f"  OK {f.relative_to(ROOT)} ({len(doc['cases'])} cases)")
    return failures


def main() -> int:
    failures = run_all()
    for msg in failures:
        print(f"  FAIL {msg}")
    print(f"{len(fixture_files())} policy fixture files, {len(failures)} failing cases")
    return 1 if failures or not fixture_files() else 0


if __name__ == "__main__":
    sys.exit(main())
