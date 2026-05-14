/**
 * S3 fixture fingerprinting + on-disk I/O.
 *
 * Lifted from openstory's `src/lib/storage/r2-recorder.ts` so the recorded
 * fixture format and key normalisation rules are byte-for-byte identical:
 * aimock can read fixtures recorded by the openstory library-layer recorder
 * and vice versa, allowing a zero-migration rollout once the host project
 * switches to routing S3 traffic through aimock.
 *
 * Fixture layout on disk:
 *   <fixtureDir>/<bucket>/<slug>__<hash>.json
 *
 * The fingerprint deliberately does NOT include body content. Keys that
 * embed ULIDs/UUIDs are normalised to placeholders before hashing so a
 * "logically same upload" hashes the same across runs. See the original
 * r2-recorder.ts for the full rationale.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface S3Fingerprint {
  bucket: string;
  key: string;
  contentType?: string;
}

export interface S3FixtureRequest {
  bucket: string;
  key: string;
  normalisedKey: string;
  contentType?: string;
  bodyHash: string;
  bodySize: number;
}

export interface S3FixtureResponse {
  /** HTTP status of the original upstream response. */
  status: number;
  /** ETag header value, surfaced back to the client on replay. */
  etag?: string;
  /**
   * Optional public URL returned by the recorder. aimock itself doesn't
   * synthesise this — when the host project records via its own library-layer
   * code, the field is populated; in aimock-driven recording it stays absent.
   * Preserved so fixtures recorded by openstory's library-layer recorder
   * round-trip unchanged through aimock.
   */
  publicUrl?: string;
  /** Same provenance note as `publicUrl`. */
  path?: string;
  /** Same provenance note as `publicUrl`. */
  fullPath?: string;
}

export interface S3FixtureFile {
  request: S3FixtureRequest;
  response: S3FixtureResponse;
}

// Match the original regexes verbatim — these are the invariants that make
// recordings portable between openstory's library-layer recorder and aimock.
const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// 6–8 char ID immediately before `_openstory.<ext>` (per-upload short hash).
const SHORT_HASH_RE = /(^|[/_])[a-zA-Z0-9]{6,8}(_openstory\.)/g;

export function normaliseKey(key: string): string {
  return key
    .replace(ULID_RE, "<ULID>")
    .replace(UUID_RE, "<UUID>")
    .replace(SHORT_HASH_RE, "$1<HASH>$2");
}

export function bodyHashHex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function fingerprintHash(fp: S3Fingerprint): string {
  return createHash("sha256")
    .update([fp.bucket, normaliseKey(fp.key), fp.contentType ?? ""].join("\x00"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Build a readable filename from the key by dropping bucket-prefix + ULID /
 * UUID material. If the key is entirely opaque, fall back to just `<hash>.json`.
 */
export function fixturePath(fixtureDir: string, fp: S3Fingerprint, hash: string): string {
  const segments = fp.key.split("/").slice(1);
  const meaningful = segments
    .map((seg) => seg.replace(ULID_RE, "").replace(UUID_RE, ""))
    .map((seg) => seg.replace(SHORT_HASH_RE, "$1$2"))
    .map((seg) => seg.replace(/^\.+/, ""))
    .filter((seg) => seg.length > 0);
  const slug = meaningful
    .join("__")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-");
  const filename = slug ? `${slug}__${hash}.json` : `${hash}.json`;
  return resolve(fixtureDir, fp.bucket, filename);
}

export function tryReadFixture(fixtureDir: string, fp: S3Fingerprint): S3FixtureFile | null {
  const filePath = fixturePath(fixtureDir, fp, fingerprintHash(fp));
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as S3FixtureFile;
  } catch {
    return null;
  }
}

export function writeFixture(
  fixtureDir: string,
  fp: S3Fingerprint,
  body: Uint8Array,
  response: S3FixtureResponse,
): string {
  const filePath = fixturePath(fixtureDir, fp, fingerprintHash(fp));
  const fixture: S3FixtureFile = {
    request: {
      bucket: fp.bucket,
      key: fp.key,
      normalisedKey: normaliseKey(fp.key),
      contentType: fp.contentType,
      bodyHash: bodyHashHex(body),
      bodySize: body.byteLength,
    },
    response,
  };
  const parent = dirname(filePath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(filePath, JSON.stringify(fixture, null, 2));
  return filePath;
}
