#!/usr/bin/env python3
"""Reference verifier for fixtures/trust/vectors/*.json.

SDKs and the native runtime must reproduce `verify_manifest`, `accept_trust_root`
and `resume_download` byte-for-byte in behaviour. Ed25519 uses `cryptography`
when importable, otherwise an `openssl` subprocess (OpenSSL >= 1.1.1).
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta
from urllib.parse import urlsplit

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
VECTOR_DIR = ROOT / "fixtures" / "trust" / "vectors"
MANIFEST_TYPE = "application/vnd.octomil.manifest.v1+json"
TRUST_ROOT_TYPE = "application/vnd.octomil.trust-root.v1+json"
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
_ED25519_SPKI_PREFIX = bytes.fromhex("302a300506032b6570032100")


class Fail(Exception):
    def __init__(self, code: str, discard_partial: bool = False):
        super().__init__(code)
        self.code = code
        self.discard_partial = discard_partial


def _utf16_key(s: str) -> bytes:
    return s.encode("utf-16-be")


def jcs(value) -> bytes:
    """RFC 8785 canonical JSON for the value space used here (no floats)."""
    if isinstance(value, bool) or value is None:
        return json.dumps(value).encode()
    if isinstance(value, int):
        return str(value).encode()
    if isinstance(value, float):
        raise ValueError("floats are not permitted in signed payloads")
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False).encode()
    if isinstance(value, list):
        return b"[" + b",".join(jcs(v) for v in value) + b"]"
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: _utf16_key(kv[0]))
        return b"{" + b",".join(jcs(k) + b":" + jcs(v) for k, v in items) + b"}"
    raise TypeError(type(value))


def pae(payload_type: str, body: bytes) -> bytes:
    t = payload_type.encode()
    return b"DSSEv1 %d %s %d %s" % (len(t), t, len(body), body)


def _b64(s: str) -> bytes:
    return base64.b64decode(s, validate=True)


def ed25519_verify(pub32: bytes, msg: bytes, sig: bytes, force_openssl: bool = False) -> bool:
    if len(pub32) != 32 or len(sig) != 64:
        return False
    if not force_openssl and not os.environ.get("OCTOMIL_TRUST_FORCE_OPENSSL"):
        try:
            from cryptography.exceptions import InvalidSignature
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        except ImportError:
            pass
        else:
            try:
                Ed25519PublicKey.from_public_bytes(pub32).verify(sig, msg)
                return True
            except InvalidSignature:
                return False
    with tempfile.TemporaryDirectory() as td:
        d = pathlib.Path(td)
        (d / "pub.der").write_bytes(_ED25519_SPKI_PREFIX + pub32)
        (d / "msg").write_bytes(msg)
        (d / "sig").write_bytes(sig)
        r = subprocess.run(
            ["openssl", "pkeyutl", "-verify", "-pubin", "-keyform", "DER", "-inkey", str(d / "pub.der"),
             "-rawin", "-in", str(d / "msg"), "-sigfile", str(d / "sig")],
            capture_output=True,
        )
        return r.returncode == 0


def _ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _ver(s: str) -> tuple[int, ...]:
    return tuple(int(p) for p in s.split("."))


def _open_envelope(env: dict, payload_type: str) -> tuple[dict, bytes, bytes]:
    """Returns (payload, payload_bytes, signed_bytes); raises on malformed or non-canonical input."""
    try:
        if env["payloadType"] != payload_type or not env["signatures"]:
            raise Fail("manifest_signature_invalid")
        body = _b64(env["payload"])
        payload = json.loads(body)
        if jcs(payload) != body:
            raise Fail("manifest_signature_invalid")
    except (KeyError, TypeError, ValueError, binascii.Error):
        raise Fail("manifest_signature_invalid")
    return payload, body, pae(payload_type, body)


def _sig_ok(pubkey_b64: str, signed: bytes, sig_b64: str) -> bool:
    try:
        return ed25519_verify(_b64(pubkey_b64), signed, _b64(sig_b64))
    except (ValueError, binascii.Error):
        return False


def _threshold_ok(env: dict, signed: bytes, root_keys: list[dict], threshold: int) -> bool:
    by_id = {k["keyid"]: k["pubkey"] for k in root_keys}
    good = {s["keyid"] for s in env["signatures"] if s["keyid"] in by_id and _sig_ok(by_id[s["keyid"]], signed, s["sig"])}
    return len(good) >= threshold


def load_policy() -> dict:
    return yaml.safe_load((ROOT / "policy" / "trust.yaml").read_text())


def _check_trust_root(v: dict, now: datetime, policy: dict) -> dict:
    env = v["trust_root"]
    payload, _, signed = _open_envelope(env, TRUST_ROOT_TYPE)
    pinned = v["pinned_root"]
    if not _threshold_ok(env, signed, pinned["root_keys"], pinned["threshold"]):
        raise Fail("manifest_signature_invalid")
    state = v.get("state", {})
    if payload["serial"] < state.get("max_trust_root_serial", 0):
        raise Fail("rollback_detected")
    if now > _ts(payload["expires_at"]):
        refreshed = state.get("trust_root_last_refresh_at")
        grace = timedelta(seconds=policy["offline"]["max_offline_age_seconds"])
        if refreshed is None or now - _ts(refreshed) > grace:
            raise Fail("manifest_expired")
    return payload


def host_allowed(host: str, patterns: list[str]) -> bool:
    host = host.lower()
    for p in patterns:
        p = p.lower()
        if p.startswith("*."):
            if host.endswith(p[1:]) and len(host) > len(p) - 1:
                return True
        elif host == p:
            return True
    return False


def _verify_signature(env: dict, root: dict, signed: bytes, issued_at: datetime) -> dict:
    keys = {k["keyid"]: k for k in root["keys"]}
    revoked = set(root["revoked_keyids"])
    signer = None
    revoked_hit = False
    for s in env["signatures"]:
        key = keys.get(s.get("keyid"))
        if key is None or not _sig_ok(key["pubkey"], signed, s.get("sig", "")):
            continue
        if key["keyid"] in revoked:
            revoked_hit = True
            continue
        if not _ts(key["not_before"]) <= issued_at <= _ts(key["not_after"]):
            continue
        signer = key
        break
    if signer is None:
        raise Fail("key_revoked" if revoked_hit else "manifest_signature_invalid")
    return signer


def verify_manifest(v: dict, policy: dict | None = None) -> dict:
    policy = policy or load_policy()
    now = _ts(v["now"])
    ctx = v["context"]
    state = v.get("state", {})
    try:
        root = _check_trust_root(v, now, policy)
        if v.get("manifest") is None:
            if ctx.get("unsigned_policy", "enforce") == "warn":
                return {"result": "warn_unverified"}
            raise Fail("manifest_signature_invalid")
        env = v["manifest"]
        m, _, signed = _open_envelope(env, MANIFEST_TYPE)
        signer = _verify_signature(env, root, signed, _ts(m["issued_at"]))

        if now >= _ts(m["expires_at"]):
            raise Fail("manifest_expired")
        if m["kind"] != ctx["kind"] or signer["scope"] not in (m["kind"], "both"):
            raise Fail("manifest_incompatible")
        if m["org_id"] is None:
            if m["kind"] == "model":
                raise Fail("forbidden")
        elif m["org_id"] != ctx.get("org_id"):
            raise Fail("forbidden")
        p, c = m["platform"], ctx["platform"]
        if p["os"] != c["os"] or p["arch"] != c["arch"] or p.get("flavor", c.get("flavor")) != c.get("flavor"):
            raise Fail("manifest_incompatible")
        need = m.get("min_sdk", {}).get(ctx["sdk"]["name"])
        if need is not None and _ver(ctx["sdk"]["version"]) < _ver(need):
            raise Fail("manifest_incompatible")
        if "abi" in m and (m["abi"]["major"] != ctx["abi"]["major"] or m["abi"]["min_minor"] > ctx["abi"]["minor"]):
            raise Fail("manifest_incompatible")

        name = m["name"]
        if m["serial"] < max(state.get("max_serial", {}).get(name, 0), root["min_serial"].get(name, 0)):
            raise Fail("rollback_detected")
        if any(f["sha256"] in set(root["revoked_digests"]) for f in m["files"]):
            raise Fail("key_revoked")
        if any(not SHA256_RE.match(f["sha256"] or "") for f in m["files"]):
            raise Fail("artifact_digest_mismatch")

        allowed = ctx.get("sdk_allowlist", [])
        for d in ctx.get("downloads", []):
            u = urlsplit(d["url"])
            if u.scheme != "https" or u.username or u.password or not u.hostname:
                raise Fail("host_not_allowed")
            if not (host_allowed(u.hostname, m["source_hosts"]) and host_allowed(u.hostname, allowed)):
                raise Fail("host_not_allowed")

        observed = {o["path"]: o for o in ctx.get("observed", [])}
        if ctx.get("observed") is not None:
            for f in m["files"]:
                o = observed.get(f["path"])
                if o is None or o["size"] != f["size"] or o["sha256"] != f["sha256"]:
                    raise Fail("artifact_digest_mismatch")
    except Fail as e:
        return {"result": "error", "code": e.code}
    return {"result": "ok"}


def accept_trust_root(v: dict) -> dict:
    now = _ts(v["now"])
    cur = v["current"]
    try:
        payload, _, signed = _open_envelope(v["candidate"], TRUST_ROOT_TYPE)
        if not _threshold_ok(v["candidate"], signed, cur["root_keys"], cur["threshold"]):
            raise Fail("manifest_signature_invalid")
        if payload["serial"] <= cur["serial"]:
            raise Fail("rollback_detected")
        if now >= _ts(payload["expires_at"]):
            raise Fail("manifest_expired")
        if payload["root_threshold"] > len(payload["root_keys"]):
            raise Fail("manifest_signature_invalid")
    except Fail as e:
        return {"result": "error", "code": e.code}
    return {"result": "ok"}


def resume_download(v: dict) -> dict:
    """Resumed bytes are never trusted: journaled chunks are re-hashed and fresh chunks verified on arrival."""
    chunks = v["manifest_chunks"]
    try:
        if v["journal"]["manifest_sha256"] != v["current_manifest_sha256"]:
            return {"result": "restart", "discard_partial": True}
        disk = {c["index"]: c["sha256"] for c in v.get("disk", [])}
        for c in v["journal"]["completed"]:
            if disk.get(c["index"]) != chunks[c["index"]]["sha256"]:
                raise Fail("artifact_digest_mismatch", discard_partial=True)
        for c in v.get("remote", []):
            if c["sha256"] != chunks[c["index"]]["sha256"]:
                raise Fail("artifact_digest_mismatch", discard_partial=True)
    except Fail as e:
        return {"result": "error", "code": e.code, "discard_partial": e.discard_partial}
    return {"result": "ok", "discard_partial": False}


OPERATIONS = {
    "verify_manifest": verify_manifest,
    "accept_trust_root": accept_trust_root,
    "resume_download": resume_download,
}


def run_vector(v: dict) -> dict:
    return OPERATIONS[v["operation"]](v)


def vector_files() -> list[pathlib.Path]:
    return sorted(VECTOR_DIR.glob("*.json"))


def run_all() -> list[str]:
    failures = []
    for f in vector_files():
        v = json.loads(f.read_text())
        got = run_vector(v)
        want = v["expect"]
        if any(got.get(k) != val for k, val in want.items()):
            failures.append(f"{f.name}: expected {want}, got {got}")
        else:
            print(f"  OK {f.relative_to(ROOT)}")
    return failures


def covered_files() -> set[pathlib.Path]:
    return set(vector_files())


def main() -> int:
    failures = run_all()
    for f in failures:
        print(f"  FAIL {f}")
    print(f"{len(vector_files()) - len(failures)}/{len(vector_files())} trust vectors passed")
    return 1 if failures or not vector_files() else 0


if __name__ == "__main__":
    sys.exit(main())
