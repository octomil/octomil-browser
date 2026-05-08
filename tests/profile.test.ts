/**
 * Tests for src/profile.ts — staging profile resolution.
 *
 * Mirrors octomil-node/tests/profile.test.ts and
 * octomil-python/tests/test_config_profile.py — keep them in
 * lockstep.
 */

import { describe, expect, test } from "vitest";

import {
  Profile,
  _resetProfileCacheForTesting,
  artifactBucketFor,
  baseUrlForV1,
  cacheNamespaceFor,
  configureProfile,
  hostUrlFor,
  profileFromString,
  resolveBaseUrlV1,
  resolveHostUrl,
  resolveProfile,
} from "../src/profile";

describe("Profile constants", () => {
  test("values match canonical names used in env_capability_manifest", () => {
    expect(Profile.Production).toBe("production");
    expect(Profile.Staging).toBe("staging");
    expect(Profile.Dev).toBe("dev");
  });
});

describe("profileFromString", () => {
  test("accepts canonical names", () => {
    expect(profileFromString("production")).toBe(Profile.Production);
    expect(profileFromString("staging")).toBe(Profile.Staging);
    expect(profileFromString("dev")).toBe(Profile.Dev);
  });

  test("is case-insensitive", () => {
    expect(profileFromString("STAGING")).toBe(Profile.Staging);
  });

  test("accepts operator aliases prod / stg", () => {
    expect(profileFromString("prod")).toBe(Profile.Production);
    expect(profileFromString("stg")).toBe(Profile.Staging);
  });

  test("rejects unknown profiles", () => {
    expect(() => profileFromString("preview")).toThrow(/unknown profile/);
  });

  test("rejects empty string", () => {
    expect(() => profileFromString("")).toThrow(/non-empty/);
  });
});

describe("URL forms", () => {
  test("host-only production does not include 'staging'", () => {
    const url = hostUrlFor(Profile.Production);
    expect(url).not.toContain("staging");
    expect(url).toBe("https://api.octomil.com");
  });

  test("host-only staging differs from production", () => {
    expect(hostUrlFor(Profile.Staging)).toBe("https://api.staging.octomil.com");
    expect(hostUrlFor(Profile.Staging)).not.toBe(hostUrlFor(Profile.Production));
  });

  test("v1 form is host with /v1 suffix per profile", () => {
    expect(baseUrlForV1(Profile.Production)).toBe("https://api.octomil.com/v1");
    expect(baseUrlForV1(Profile.Staging)).toBe(
      "https://api.staging.octomil.com/v1",
    );
  });

  test("dev URL is localhost-shaped", () => {
    expect(hostUrlFor(Profile.Dev).startsWith("http://localhost")).toBe(true);
  });
});

describe("artifactBucketFor", () => {
  test("each profile has a distinct bucket name", () => {
    const buckets = new Set([
      artifactBucketFor(Profile.Production),
      artifactBucketFor(Profile.Staging),
      artifactBucketFor(Profile.Dev),
    ]);
    expect(buckets.size).toBe(3);
    expect(artifactBucketFor(Profile.Production)).toBe("octomil-models");
    expect(artifactBucketFor(Profile.Staging)).toBe("octomil-models-staging");
  });

  test("staging bucket name does not contain 'prod'", () => {
    expect(artifactBucketFor(Profile.Staging).toLowerCase()).not.toContain(
      "prod",
    );
  });
});

describe("cacheNamespaceFor", () => {
  test("namespace embeds profile name", () => {
    expect(cacheNamespaceFor(Profile.Production)).toBe("oct.production");
    expect(cacheNamespaceFor(Profile.Staging)).toBe("oct.staging");
  });

  test("no two profiles share a namespace", () => {
    const ns = new Set([
      cacheNamespaceFor(Profile.Production),
      cacheNamespaceFor(Profile.Staging),
      cacheNamespaceFor(Profile.Dev),
    ]);
    expect(ns.size).toBe(3);
  });
});

describe("resolveProfile — explicit argument", () => {
  test("explicit arg wins over env", () => {
    const res = resolveProfile({
      profile: "staging",
      env: { OCTOMIL_PROFILE: "production" },
    });
    expect(res.profile).toBe(Profile.Staging);
    expect(res.source).toBe("explicit");
  });

  test("invalid explicit arg raises", () => {
    expect(() => resolveProfile({ profile: "preview" })).toThrow(
      /unknown profile/,
    );
  });

  test("empty explicit arg falls through", () => {
    const res = resolveProfile({
      profile: "  ",
      env: { OCTOMIL_PROFILE: "staging" },
    });
    expect(res.source).toBe("env");
  });
});

describe("resolveProfile — env dict", () => {
  test("OCTOMIL_PROFILE picks staging", () => {
    const res = resolveProfile({ env: { OCTOMIL_PROFILE: "staging" } });
    expect(res.profile).toBe(Profile.Staging);
    expect(res.source).toBe("env");
  });

  test("empty OCTOMIL_PROFILE treated as unset", () => {
    const res = resolveProfile({ env: { OCTOMIL_PROFILE: "" } });
    expect(res.profile).toBe(Profile.Production);
    expect(res.source).toBe("default");
  });

  test("case-insensitive", () => {
    const res = resolveProfile({ env: { OCTOMIL_PROFILE: "STAGING" } });
    expect(res.profile).toBe(Profile.Staging);
  });
});

describe("resolveProfile — URL inference", () => {
  test("infers staging from OCTOMIL_API_BASE", () => {
    const res = resolveProfile({
      env: { OCTOMIL_API_BASE: "https://api.staging.octomil.com/v1" },
    });
    expect(res.profile).toBe(Profile.Staging);
    expect(res.source).toBe("url_inferred");
  });

  test("infers production from OCTOMIL_API_URL", () => {
    const res = resolveProfile({
      env: { OCTOMIL_API_URL: "https://api.octomil.com" },
    });
    expect(res.profile).toBe(Profile.Production);
    expect(res.source).toBe("url_inferred");
  });

  test("infers dev from localhost / 127.0.0.1", () => {
    expect(
      resolveProfile({ env: { OCTOMIL_API_BASE: "http://localhost:8000" } })
        .profile,
    ).toBe(Profile.Dev);
    expect(
      resolveProfile({ env: { OCTOMIL_API_BASE: "http://127.0.0.1:8000" } })
        .profile,
    ).toBe(Profile.Dev);
  });

  test("env profile overrides URL inference", () => {
    const res = resolveProfile({
      env: {
        OCTOMIL_PROFILE: "staging",
        OCTOMIL_API_BASE: "https://api.octomil.com",
      },
    });
    expect(res.profile).toBe(Profile.Staging);
    expect(res.source).toBe("env");
  });

  test("unmatched URL falls through to default", () => {
    const res = resolveProfile({
      env: { OCTOMIL_API_BASE: "https://example.com/api" },
    });
    expect(res.profile).toBe(Profile.Production);
    expect(res.source).toBe("default");
  });
});

describe("resolveProfile — default", () => {
  test("no signals → production", () => {
    const res = resolveProfile({ env: {} });
    expect(res.profile).toBe(Profile.Production);
    expect(res.source).toBe("default");
  });

  test("no options at all → production (browser-safe)", () => {
    // No process.env, no options dict — must still return a valid
    // ProfileResolution and not throw.
    const res = resolveProfile();
    expect(res.profile).toBe(Profile.Production);
    expect(res.source).toBe("default");
  });
});

describe("resolveHostUrl / resolveBaseUrlV1", () => {
  test("explicit baseUrl wins (host form)", () => {
    expect(
      resolveHostUrl({
        baseUrl: "https://custom.example.com",
        env: { OCTOMIL_PROFILE: "staging" },
      }),
    ).toBe("https://custom.example.com");
  });

  test("explicit baseUrl wins (v1 form)", () => {
    expect(
      resolveBaseUrlV1({
        baseUrl: "https://custom.example.com",
        env: { OCTOMIL_PROFILE: "staging" },
      }),
    ).toBe("https://custom.example.com");
  });

  test("staging profile picks host-only URL", () => {
    expect(resolveHostUrl({ env: { OCTOMIL_PROFILE: "staging" } })).toBe(
      "https://api.staging.octomil.com",
    );
  });

  test("staging profile picks v1 URL", () => {
    expect(resolveBaseUrlV1({ env: { OCTOMIL_PROFILE: "staging" } })).toBe(
      "https://api.staging.octomil.com/v1",
    );
  });

  test("default returns production URL", () => {
    expect(resolveHostUrl({ env: {} })).toBe("https://api.octomil.com");
    expect(resolveBaseUrlV1({ env: {} })).toBe("https://api.octomil.com/v1");
  });
});

describe("cross-profile isolation", () => {
  test("no two profiles share a host URL", () => {
    const urls = new Set([
      hostUrlFor(Profile.Production),
      hostUrlFor(Profile.Staging),
      hostUrlFor(Profile.Dev),
    ]);
    expect(urls.size).toBe(3);
  });
});

// Codex post-debate B1: hostile-URL inference safety.
describe("hostile-URL inference", () => {
  test("marker in query string does not spoof profile", () => {
    const res = resolveProfile({
      env: { OCTOMIL_API_BASE: "https://evil.test/?next=api.staging.octomil.com" },
    });
    expect(res.profile).toBe(Profile.Production);
    expect(res.source).toBe("default");
  });

  test("marker in path does not spoof profile", () => {
    const res = resolveProfile({
      env: { OCTOMIL_API_BASE: "https://evil.test/api.octomil.com/v1" },
    });
    expect(res.profile).toBe(Profile.Production);
  });

  test("marker in userinfo does not spoof profile", () => {
    const res = resolveProfile({
      env: { OCTOMIL_API_BASE: "https://api.staging.octomil.com@evil.test/v1" },
    });
    expect(res.profile).toBe(Profile.Production);
  });

  test("superdomain does not spoof production", () => {
    const res = resolveProfile({
      env: { OCTOMIL_API_BASE: "https://api.octomil.com.evil.test/v1" },
    });
    expect(res.profile).toBe(Profile.Production);
  });

  test("unparseable URL falls through safely", () => {
    const res = resolveProfile({
      env: { OCTOMIL_API_BASE: "not a url" },
    });
    expect(res.profile).toBe(Profile.Production);
  });
});

// Codex post-debate N1: whitespace fallback.
describe("whitespace handling", () => {
  test("whitespace OCTOMIL_API_BASE falls back to OCTOMIL_API_URL", () => {
    const res = resolveProfile({
      env: {
        OCTOMIL_API_BASE: "   ",
        OCTOMIL_API_URL: "https://api.staging.octomil.com",
      },
    });
    expect(res.profile).toBe(Profile.Staging);
    expect(res.source).toBe("url_inferred");
  });
});

// Codex R3 B2: module-level configureProfile lets boot code wire
// OCTOMIL_PROFILE / import.meta.env once so all subsequent SDK
// constructors flip in lockstep.
describe("configureProfile module cache", () => {
  test("configureProfile({profile}) flips resolveProfile default", () => {
    _resetProfileCacheForTesting();
    configureProfile({ profile: "staging" });
    const res = resolveProfile();
    expect(res.profile).toBe(Profile.Staging);
    expect(res.source).toBe("explicit");
    _resetProfileCacheForTesting();
  });

  test("configureProfile({env}) flips resolveProfile via env", () => {
    _resetProfileCacheForTesting();
    configureProfile({ env: { OCTOMIL_PROFILE: "staging" } });
    const res = resolveProfile();
    expect(res.profile).toBe(Profile.Staging);
    expect(res.source).toBe("env");
    _resetProfileCacheForTesting();
  });

  test("configureProfile({env}) flows through resolveHostUrl with no args", () => {
    _resetProfileCacheForTesting();
    configureProfile({ env: { OCTOMIL_PROFILE: "staging" } });
    expect(resolveHostUrl()).toBe("https://api.staging.octomil.com");
    _resetProfileCacheForTesting();
  });

  test("explicit options.env overrides module cache", () => {
    _resetProfileCacheForTesting();
    configureProfile({ profile: "staging" });
    const res = resolveProfile({ env: {} });
    // options.profile is undefined here, options.env is {} (provided),
    // so options.env wins over module cache for env. But module
    // _moduleProfile is set so explicit branch fires anyway.
    expect(res.profile).toBe(Profile.Staging);
    _resetProfileCacheForTesting();
  });

  test("after _resetProfileCacheForTesting, defaults to production", () => {
    configureProfile({ profile: "staging" });
    _resetProfileCacheForTesting();
    expect(resolveProfile().profile).toBe(Profile.Production);
  });
});
