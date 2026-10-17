// TODO(trust): PLACEHOLDER generated from the public TEST root (scripts/inject-trust-root.mjs --from-test-vectors).
// The production root MUST be injected at build time via OCTOMIL_TRUST_ROOT_JSON with OCTOMIL_BUILD_ENV=production.
// Production builds refuse this file; anyone holding the test keys can sign manifests this build trusts.
import type { Envelope, PinnedRoot } from "./types.js";

export const BUILD_PRODUCTION = false;
export const PINNED_ROOT: PinnedRoot = {
  "threshold": 2,
  "root_keys": [
    {
      "keyid": "root-a",
      "pubkey": "D+tgcji2veQ2Oyobrv5P1CFnxSAkNrSisOiLtFeiH1c="
    },
    {
      "keyid": "root-b",
      "pubkey": "xrraPC0RsI/UlVW04jcwj6ooolXmsZFvaISJc8R8+S4="
    },
    {
      "keyid": "root-c",
      "pubkey": "fGZCdbaZe5P5Nx9xjsjyCOGTLddEBa/PoBp2mXnpxV0="
    }
  ]
};
export const INITIAL_TRUST_ROOT: Envelope = {
  "payloadType": "application/vnd.octomil.trust-root.v1+json",
  "payload": "eyJleHBpcmVzX2F0IjoiMjAyNy0wMy0wMVQwMDowMDowMFoiLCJpc3N1ZWRfYXQiOiIyMDI2LTA5LTAxVDAwOjAwOjAwWiIsImtleXMiOlt7ImtleWlkIjoicmVsZWFzZS0yMDI2LWEiLCJub3RfYWZ0ZXIiOiIyMDI3LTAxLTAxVDAwOjAwOjAwWiIsIm5vdF9iZWZvcmUiOiIyMDI2LTAxLTAxVDAwOjAwOjAwWiIsInB1YmtleSI6Ik9rUktLYmFjK1RKdHNCMjUwc2QvMWFwS3drazJDRU9JOHFTbU52TUp0bm89Iiwic2NvcGUiOiJib3RoIn0seyJrZXlpZCI6InJlbGVhc2UtbW9kZWwtb25seSIsIm5vdF9hZnRlciI6IjIwMjctMDEtMDFUMDA6MDA6MDBaIiwibm90X2JlZm9yZSI6IjIwMjYtMDEtMDFUMDA6MDA6MDBaIiwicHVia2V5IjoiUzhyRjlSYmF4cmtKYVlqdjZaaFA0WTFHUHRUblNQbkNyUElvRTNjd01XMD0iLCJzY29wZSI6Im1vZGVsIn0seyJrZXlpZCI6InJlbGVhc2UtcnVudGltZS1vbmx5Iiwibm90X2FmdGVyIjoiMjAyNy0wMS0wMVQwMDowMDowMFoiLCJub3RfYmVmb3JlIjoiMjAyNi0wMS0wMVQwMDowMDowMFoiLCJwdWJrZXkiOiI5OHNsYnNYdWtjSUdZQ2J5d1grNTIrb0h0Yk1JN2doZGhxNjh3SEdnUGZFPSIsInNjb3BlIjoicnVudGltZSJ9LHsia2V5aWQiOiJyZWxlYXNlLXJldm9rZWQiLCJub3RfYWZ0ZXIiOiIyMDI3LTAxLTAxVDAwOjAwOjAwWiIsIm5vdF9iZWZvcmUiOiIyMDI2LTAxLTAxVDAwOjAwOjAwWiIsInB1YmtleSI6InVLSzhmbEpSSk96YVYvblJ3KzRhRVRIeC9zaWwzK2x1L3BINThiQ0tYdkE9Iiwic2NvcGUiOiJib3RoIn0seyJrZXlpZCI6InJlbGVhc2Utb2xkIiwibm90X2FmdGVyIjoiMjAyNi0wNi0zMFQwMDowMDowMFoiLCJub3RfYmVmb3JlIjoiMjAyNS0wMS0wMVQwMDowMDowMFoiLCJwdWJrZXkiOiJlVklENzJSVXFLb0pQQklKZ0w2Z2dmYjAreUw0TkRxNHp3Mk1GdGlmR1VJPSIsInNjb3BlIjoiYm90aCJ9XSwibWluX3NlcmlhbCI6e30sInJldm9rZWRfZGlnZXN0cyI6W10sInJldm9rZWRfa2V5aWRzIjpbInJlbGVhc2UtcmV2b2tlZCJdLCJyb290X2tleXMiOlt7ImtleWlkIjoicm9vdC1hIiwicHVia2V5IjoiRCt0Z2NqaTJ2ZVEyT3lvYnJ2NVAxQ0ZueFNBa05yU2lzT2lMdEZlaUgxYz0ifSx7ImtleWlkIjoicm9vdC1iIiwicHVia2V5IjoieHJyYVBDMFJzSS9VbFZXMDRqY3dqNm9vb2xYbXNaRnZhSVNKYzhSOCtTND0ifSx7ImtleWlkIjoicm9vdC1jIiwicHVia2V5IjoiZkdaQ2RiYVplNVA1Tng5eGpzanlDT0dUTGRkRUJhL1BvQnAybVhucHhWMD0ifV0sInJvb3RfdGhyZXNob2xkIjoyLCJzY2hlbWEiOiJvY3RvbWlsLnRydXN0X3Jvb3QvMSIsInNlcmlhbCI6M30=",
  "signatures": [
    {
      "keyid": "root-a",
      "sig": "dSyU3VHV26nC9ov9wUU5dHwD3/k0ja22GMdX6K1268GSD/PPNRCQ3Qptodt9y4pl9Z0R8OsYP4Qbhs6OyX6qDQ=="
    },
    {
      "keyid": "root-b",
      "sig": "0dCyQupkJBqbLkyu+69kCeFDTgBNBPZ2S5xy9CX4JxtPISG7kXpYTvFgEtNrk/+/3Yh+zrdzptWPprXOB0oXDw=="
    }
  ]
};
