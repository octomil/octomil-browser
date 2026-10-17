import { describe, expect, it } from "vitest";
import { b64decode, pae } from "../../src/trust/dsse.js";
import { hostAllowed, parseHttpsUrl } from "../../src/trust/hosts.js";
import { jcs } from "../../src/trust/jcs.js";
import { assertNoTestRoot, loadEmbeddedRoot } from "../../src/trust/pinned-root.js";
import { INITIAL_TRUST_ROOT, PINNED_ROOT } from "../../src/trust/pinned-root.data.js";
import { MemoryTrustStore } from "../../src/trust/store.js";

describe("jcs", () => {
  it("sorts keys by UTF-16 code unit and emits no whitespace", () => {
    expect(jcs({ b: 1, a: [true, null, "x"], "é": 2, "😀": 3 })).toBe('{"a":[true,null,"x"],"b":1,"é":2,"😀":3}');
  });

  it("rejects floats", () => {
    expect(() => jcs({ a: 1.5 })).toThrow();
  });
});

describe("pae and base64", () => {
  it("builds DSSEv1 with decimal lengths", () => {
    expect(new TextDecoder().decode(pae("t/x", new TextEncoder().encode("abc")))).toBe("DSSEv1 3 t/x 3 abc");
  });

  it("rejects unpadded, whitespace and url-safe base64", () => {
    expect(Array.from(b64decode("aGk="))).toEqual([104, 105]);
    for (const bad of ["aGk", "aG k=", "aG-_", "aGk=\n"]) expect(() => b64decode(bad)).toThrow();
  });
});

describe("hosts", () => {
  it("wildcards match subdomains only", () => {
    expect(hostAllowed("a.octomil.com", ["*.octomil.com"])).toBe(true);
    expect(hostAllowed("octomil.com", ["*.octomil.com"])).toBe(false);
    expect(hostAllowed("evil-octomil.com", ["*.octomil.com"])).toBe(false);
  });

  it("parseHttpsUrl rejects http, userinfo and garbage", () => {
    expect(parseHttpsUrl("https://a.octomil.com/x")?.hostname).toBe("a.octomil.com");
    for (const bad of ["http://a.octomil.com", "https://u:p@a.octomil.com", "https://@a.octomil.com", "nope"]) {
      expect(parseHttpsUrl(bad)).toBeNull();
    }
  });
});

describe("embedded root", () => {
  it("is the TEST placeholder in this checkout and loads outside production", () => {
    expect(loadEmbeddedRoot(false)).toEqual({ pinned: PINNED_ROOT, trustRoot: INITIAL_TRUST_ROOT });
  });

  it("refuses the test root in a production build", () => {
    expect(() => loadEmbeddedRoot(true)).toThrow(/TEST trust root/);
    expect(() => assertNoTestRoot(PINNED_ROOT, true)).toThrow();
    expect(() => assertNoTestRoot({ threshold: 2, root_keys: [{ keyid: "r", pubkey: "AAAA" }] }, true)).not.toThrow();
  });
});

describe("MemoryTrustStore", () => {
  it("applies state updates atomically and isolates callers from stored objects", async () => {
    const s = new MemoryTrustStore();
    await Promise.all([1, 2, 3].map((n) => s.updateState((st) => ({ ...st, max_serial: { ...st.max_serial, [`m${n}`]: n } }))));
    const st = await s.getState();
    expect(st.max_serial).toEqual({ m1: 1, m2: 2, m3: 3 });
    st.max_serial!.m1 = 99;
    expect((await s.getState()).max_serial!.m1).toBe(1);
  });
});
