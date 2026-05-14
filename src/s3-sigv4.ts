/**
 * AWS Signature Version 4 — minimal implementation for PUT object.
 *
 * Spec: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv4-signing-elements.html
 *
 * Only what's needed to PUT a binary body at a path-style URL like
 *   `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`
 * with `service=s3`, `region=auto`. Implemented with `node:crypto` so the
 * package keeps its zero-runtime-dependency promise.
 *
 * Limitations vs. @aws-sdk/client-s3:
 *   - PUT object only. No GET / HEAD / DELETE signing (aimock proxies *PUTs*
 *     to upstream; downstream GETs hit aimock's in-memory state or the real
 *     CDN via the recorded publicUrl).
 *   - No chunked / streaming-signed bodies. The whole payload is hashed
 *     up front — fine for the fixtures-recording case, where every PUT body
 *     is already buffered into memory.
 *   - No session-token / STS support. Static access keys only.
 */

import { createHash, createHmac } from "node:crypto";

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional session token for temporary credentials. Set as x-amz-security-token header when present. */
  sessionToken?: string;
}

export interface SigV4PutRequest {
  /** Full upstream URL, e.g. `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`. */
  url: string;
  /** Request body to PUT. */
  body: Uint8Array;
  /** Content-Type, included in the signed canonical headers when present. */
  contentType?: string;
  /** AWS region. R2 uses `auto`; AWS S3 defaults to `us-east-1`. */
  region: string;
  /** Service name. Always `s3` for R2 / S3. */
  service: string;
  /** Fixed timestamp for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
}

export interface SignedRequest {
  /** Headers to send with the PUT, including `Authorization` and `x-amz-*`. */
  headers: Record<string, string>;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function amzDate(d: Date): { dateStamp: string; amzDate: string } {
  // 20210101T000000Z + 20210101
  const iso = d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function uriEncodePath(pathname: string): string {
  // Per SigV4: encode each path segment but keep `/` separators. Don't
  // encode unreserved chars (A-Z a-z 0-9 - _ . ~). S3 (and R2) want the
  // canonical URI to match what the SDK signs — for path-style URLs this
  // means each segment is encoded but the slashes between them aren't.
  return pathname
    .split("/")
    .map((seg) =>
      seg.replace(/[^A-Za-z0-9\-_.~]/g, (c) => {
        const hex = c
          .split("")
          .map((ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))
          .join("");
        return hex;
      }),
    )
    .join("/");
}

/**
 * Sign a PUT request. Returns the headers to set on the outgoing HTTPS request.
 * The body is passed in for payload hashing only — the caller is still
 * responsible for actually writing it.
 */
export function signS3PutRequest(req: SigV4PutRequest, creds: SigV4Credentials): SignedRequest {
  const url = new URL(req.url);
  const { amzDate: amzDateStr, dateStamp } = amzDate(req.now ?? new Date());
  const payloadHash = sha256Hex(req.body);

  // Canonical headers — keys must be lowercased, sorted, trimmed. `host` is
  // always signed; we also sign content-type (when present) and the x-amz-*
  // standard headers. content-length is intentionally NOT signed: AWS SDK
  // omits it from canonical headers and S3 / R2 accept it that way.
  const canonicalHeaders: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDateStr,
  };
  if (req.contentType) canonicalHeaders["content-type"] = req.contentType;
  if (creds.sessionToken) canonicalHeaders["x-amz-security-token"] = creds.sessionToken;

  const sortedHeaderNames = Object.keys(canonicalHeaders).sort();
  const canonicalHeadersStr =
    sortedHeaderNames.map((h) => `${h}:${canonicalHeaders[h].trim()}`).join("\n") + "\n";
  const signedHeaders = sortedHeaderNames.join(";");

  // Canonical URI / query — path-style only, query string usually empty for PUT object.
  const canonicalUri = uriEncodePath(url.pathname || "/");
  const canonicalQuery = url.search ? url.search.slice(1) : "";

  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQuery,
    canonicalHeadersStr,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDateStr,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  // Derive signing key — the spec's four-step HMAC chain.
  const kDate = hmac("AWS4" + creds.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, req.region);
  const kService = hmac(kRegion, req.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const authHeader = [
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");

  const outgoing: Record<string, string> = {
    Host: url.host,
    "X-Amz-Content-Sha256": payloadHash,
    "X-Amz-Date": amzDateStr,
    Authorization: authHeader,
    "Content-Length": String(req.body.byteLength),
  };
  if (req.contentType) outgoing["Content-Type"] = req.contentType;
  if (creds.sessionToken) outgoing["X-Amz-Security-Token"] = creds.sessionToken;
  return { headers: outgoing };
}
