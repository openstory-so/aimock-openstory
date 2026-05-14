/**
 * S3-compatible mock endpoint at `/s3/<bucket>/<key>`.
 *
 * Path-style addressing only — virtual-hosted-style (`<bucket>.host/<key>`) is
 * intentionally not supported. Clients route to aimock by setting
 * `AWS_ENDPOINT_URL_S3=http://<aimock>/s3` and `forcePathStyle: true` on the
 * S3 client (AWS SDK v3 honours both natively). The host project's code stays
 * test-unaware: only the env var differs between prod and e2e.
 *
 * SigV4 is *not* validated. aimock accepts whatever the client signed (or
 * didn't) and never round-trips it back, so signature mismatches are
 * structurally impossible.
 *
 * State is per-server-instance and held in memory (`S3State`). PUT writes
 * populate it; GET / HEAD read from it; DELETE removes from it. State resets
 * on `LLMock.reset()` via the explicit `clear()` call in server.ts.
 *
 * Three operating modes:
 *   - 'live'   — no fixture I/O; in-memory only. PUT-then-GET works within a
 *                single server instance, vanishes on restart.
 *   - 'record' — same as live, plus PUT writes a metadata fixture under
 *                `<fixtureDir>/<bucket>/<slug>__<hash>.json` so a later replay
 *                run finds the same fingerprint.
 *   - 'replay' — PUT looks up a fixture by fingerprint and 503s on miss. The
 *                in-memory state still records the body so subsequent same-
 *                process GETs serve real bytes (useful for server-side flows
 *                that PUT-then-GET within one test).
 */

import type * as http from "node:http";
import * as https from "node:https";
import * as nodeHttp from "node:http";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { S3UpstreamConfig } from "./types.js";
import { flattenHeaders } from "./helpers.js";
import {
  bodyHashHex,
  fingerprintHash,
  tryReadFixture,
  writeFixture,
  type S3Fingerprint,
  type S3FixtureResponse,
} from "./s3-recorder.js";
import { signS3PutRequest } from "./s3-sigv4.js";

export type S3Mode = "live" | "record" | "replay";

export interface S3HandlerConfig {
  mode: S3Mode;
  fixtureDir: string;
  logger: Logger;
  /** Real S3-compatible upstream for record-mode PUT forwarding. */
  upstream?: S3UpstreamConfig;
  /** Build the persisted publicUrl in record-mode fixtures. */
  publicUrlBuilder?: (req: { bucket: string; key: string }) => string;
}

export interface S3Object {
  body: Uint8Array;
  contentType?: string;
  etag: string;
}

/** In-memory bucket+key → object store. Reset on `LLMock.reset()`. */
export class S3State {
  private readonly objects = new Map<string, S3Object>();

  static keyOf(bucket: string, key: string): string {
    return `${bucket}/${key}`;
  }

  get(bucket: string, key: string): S3Object | undefined {
    return this.objects.get(S3State.keyOf(bucket, key));
  }

  set(bucket: string, key: string, obj: S3Object): void {
    this.objects.set(S3State.keyOf(bucket, key), obj);
  }

  delete(bucket: string, key: string): boolean {
    return this.objects.delete(S3State.keyOf(bucket, key));
  }

  clear(): void {
    this.objects.clear();
  }

  get size(): number {
    return this.objects.size;
  }
}

/** Match `/s3/<bucket>/<key>` and anything below `/s3`. */
export const S3_PREFIX_RE = /^\/s3(?:\/|$)/;

interface ParsedS3Path {
  bucket: string;
  key: string;
}

function parseS3Path(pathname: string): ParsedS3Path | null {
  // Strip leading `/s3/` (or just `/s3`).
  if (!pathname.startsWith("/s3")) return null;
  let rest = pathname.slice(3);
  if (rest.startsWith("/")) rest = rest.slice(1);
  if (!rest) return null;
  const slash = rest.indexOf("/");
  if (slash === -1) {
    // Bucket-level operation (`/s3/<bucket>`) — not supported in v1.
    return null;
  }
  const bucket = rest.slice(0, slash);
  const key = rest.slice(slash + 1);
  if (!bucket || !key) return null;
  return { bucket, key };
}

async function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const buffers: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      req.destroy();
      throw new Error(`S3 PUT body exceeded size limit of ${maxBytes} bytes`);
    }
    buffers.push(buf);
  }
  return new Uint8Array(Buffer.concat(buffers));
}

function buildEtag(body: Uint8Array): string {
  return `"mock-${bodyHashHex(body).slice(0, 16)}"`;
}

interface UpstreamPutResult {
  status: number;
  etag?: string;
  /** Captured upstream body — small in the success path (S3 returns empty body on PUT). */
  body: string;
}

/**
 * Re-sign and forward a PUT to the configured real S3-compatible endpoint.
 * Returns the upstream status + ETag header so we can persist it in the
 * fixture and surface it back to the client.
 */
function proxyPutUpstream(
  upstream: S3UpstreamConfig,
  bucket: string,
  key: string,
  body: Uint8Array,
  contentType: string | undefined,
): Promise<UpstreamPutResult> {
  const endpointUrl = new URL(upstream.endpoint);
  // Path-style — append `/<bucket>/<key>` to the endpoint host.
  const fullUrl = new URL(`/${bucket}/${key}`, endpointUrl).toString();
  const region = upstream.region ?? "auto";
  const service = upstream.service ?? "s3";

  const signed = signS3PutRequest(
    { url: fullUrl, body, contentType, region, service },
    {
      accessKeyId: upstream.accessKeyId,
      secretAccessKey: upstream.secretAccessKey,
      sessionToken: upstream.sessionToken,
    },
  );

  return new Promise<UpstreamPutResult>((resolve, reject) => {
    const target = new URL(fullUrl);
    const transport = target.protocol === "https:" ? https : nodeHttp;
    const timeoutMs = upstream.timeoutMs ?? 30_000;
    const req = transport.request(
      target,
      { method: "PUT", headers: signed.headers, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks).toString("utf-8");
          const etagHeader = res.headers["etag"];
          resolve({
            status: res.statusCode ?? 0,
            etag: Array.isArray(etagHeader) ? etagHeader[0] : etagHeader,
            body: buf,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error(`S3 upstream PUT timed out after ${timeoutMs}ms`)),
    );
    req.on("error", reject);
    req.write(Buffer.from(body));
    req.end();
  });
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * Top-level dispatcher for `/s3/*` paths. Returns whether the request was
 * handled — callers can use the boolean to fall through to other dispatchers,
 * but in practice the server only invokes this when S3_PREFIX_RE already
 * matched.
 */
export async function handleS3(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  state: S3State,
  config: S3HandlerConfig,
  journal: Journal,
  maxBodyBytes: number,
): Promise<void> {
  const parsed = parseS3Path(pathname);
  if (!parsed) {
    journal.add({
      method: req.method ?? "?",
      path: pathname,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
      service: "s3",
    });
    writeJson(res, 400, {
      error: { message: "Expected path-style /s3/<bucket>/<key>", type: "invalid_request" },
    });
    return;
  }
  const method = req.method ?? "GET";

  switch (method) {
    case "PUT":
      await handlePut(req, res, parsed, state, config, journal, maxBodyBytes);
      return;
    case "GET":
    case "HEAD":
      handleGetOrHead(req, res, parsed, state, journal, method === "HEAD");
      return;
    case "DELETE":
      handleDelete(req, res, parsed, state, journal);
      return;
    default:
      journal.add({
        method,
        path: pathname,
        headers: flattenHeaders(req.headers),
        body: null,
        response: { status: 405, fixture: null },
        service: "s3",
      });
      res.writeHead(405, { Allow: "PUT, GET, HEAD, DELETE", "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `Method ${method} not allowed on S3 object`,
            type: "method_not_allowed",
          },
        }),
      );
      return;
  }
}

async function handlePut(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsed: ParsedS3Path,
  state: S3State,
  config: S3HandlerConfig,
  journal: Journal,
  maxBodyBytes: number,
): Promise<void> {
  const { bucket, key } = parsed;
  const contentType =
    typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined;
  const fp: S3Fingerprint = { bucket, key, contentType };

  let body: Uint8Array;
  try {
    body = await readRequestBody(req, maxBodyBytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to read PUT body";
    config.logger.error(`[s3] PUT ${bucket}/${key}: ${msg}`);
    journal.add({
      method: "PUT",
      path: req.url ?? `/s3/${bucket}/${key}`,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 413, fixture: null },
      service: "s3",
    });
    writeJson(res, 413, { error: { message: msg, type: "payload_too_large" } });
    return;
  }

  if (config.mode === "replay") {
    const fixture = tryReadFixture(config.fixtureDir, fp);
    if (!fixture) {
      const hash = fingerprintHash(fp);
      config.logger.warn(
        `[s3] replay: no fixture for ${bucket}/${key} (fingerprint=${hash}). Re-record to refresh.`,
      );
      journal.add({
        method: "PUT",
        path: req.url ?? `/s3/${bucket}/${key}`,
        headers: flattenHeaders(req.headers),
        body: null,
        response: { status: 503, fixture: null },
        service: "s3",
      });
      writeJson(res, 503, {
        error: {
          message: `S3 replay miss for ${bucket}/${key} (fingerprint=${hash})`,
          type: "fixture_miss",
        },
      });
      return;
    }
    // Cache the live body so subsequent same-process GETs serve real bytes
    // even though the fixture only persisted metadata.
    const etag = fixture.response.etag ?? buildEtag(body);
    state.set(bucket, key, { body, contentType, etag });
    const responseHeaders: Record<string, string> = { ETag: etag };
    if (fixture.response.publicUrl) {
      responseHeaders["X-LLMock-S3-Public-Url"] = fixture.response.publicUrl;
    }
    res.writeHead(fixture.response.status, responseHeaders);
    res.end();
    journal.add({
      method: "PUT",
      path: req.url ?? `/s3/${bucket}/${key}`,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: fixture.response.status, fixture: null, source: "fixture" },
      service: "s3",
    });
    return;
  }

  // live + record: store in memory; record also proxies + writes fixture.
  let responseStatus = 200;
  let responseEtag = buildEtag(body);
  let recordedPublicUrl: string | undefined;
  let recordErrorMessage: string | undefined;

  if (config.mode === "record" && config.upstream) {
    try {
      const up = await proxyPutUpstream(config.upstream, bucket, key, body, contentType);
      if (up.status < 200 || up.status >= 300) {
        config.logger.error(
          `[s3] upstream PUT ${bucket}/${key} returned ${up.status}: ${up.body.slice(0, 200)}`,
        );
        // Surface the upstream error to the client so the test fails loudly
        // instead of silently caching a broken fixture.
        journal.add({
          method: "PUT",
          path: req.url ?? `/s3/${bucket}/${key}`,
          headers: flattenHeaders(req.headers),
          body: null,
          response: { status: up.status, fixture: null, source: "proxy" },
          service: "s3",
        });
        res.writeHead(up.status, { "Content-Type": "application/xml" });
        res.end(up.body);
        return;
      }
      responseStatus = up.status;
      if (up.etag) responseEtag = up.etag;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown upstream error";
      config.logger.error(`[s3] upstream PUT failed for ${bucket}/${key}: ${msg}`);
      journal.add({
        method: "PUT",
        path: req.url ?? `/s3/${bucket}/${key}`,
        headers: flattenHeaders(req.headers),
        body: null,
        response: { status: 502, fixture: null, source: "proxy" },
        service: "s3",
      });
      writeJson(res, 502, {
        error: { message: `S3 upstream PUT failed: ${msg}`, type: "proxy_error" },
      });
      return;
    }
  }

  state.set(bucket, key, { body, contentType, etag: responseEtag });

  if (config.mode === "record") {
    if (config.publicUrlBuilder) {
      try {
        recordedPublicUrl = config.publicUrlBuilder({ bucket, key });
      } catch (err) {
        config.logger.warn(
          `[s3] publicUrlBuilder threw for ${bucket}/${key}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    const fixtureResponse: S3FixtureResponse = {
      status: responseStatus,
      etag: responseEtag,
      ...(recordedPublicUrl ? { publicUrl: recordedPublicUrl } : {}),
    };
    try {
      const filePath = writeFixture(config.fixtureDir, fp, body, fixtureResponse);
      config.logger.warn(`[s3] recorded fixture → ${filePath}`);
    } catch (err) {
      recordErrorMessage = err instanceof Error ? err.message : "Unknown filesystem error";
      config.logger.error(
        `[s3] failed to write fixture for ${bucket}/${key}: ${recordErrorMessage}`,
      );
    }
  }

  const responseHeaders: Record<string, string> = { ETag: responseEtag };
  if (recordedPublicUrl) responseHeaders["X-LLMock-S3-Public-Url"] = recordedPublicUrl;
  if (recordErrorMessage) responseHeaders["X-LLMock-Record-Error"] = recordErrorMessage;
  res.writeHead(responseStatus, responseHeaders);
  res.end();
  journal.add({
    method: "PUT",
    path: req.url ?? `/s3/${bucket}/${key}`,
    headers: flattenHeaders(req.headers),
    body: null,
    response: {
      status: responseStatus,
      fixture: null,
      source: config.mode === "record" ? "proxy" : "internal",
    },
    service: "s3",
  });
}

function handleGetOrHead(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsed: ParsedS3Path,
  state: S3State,
  journal: Journal,
  headOnly: boolean,
): void {
  const { bucket, key } = parsed;
  const obj = state.get(bucket, key);
  if (!obj) {
    journal.add({
      method: headOnly ? "HEAD" : "GET",
      path: req.url ?? `/s3/${bucket}/${key}`,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 404, fixture: null },
      service: "s3",
    });
    res.writeHead(404, { "Content-Type": "application/xml" });
    res.end(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><Key>${key}</Key></Error>`,
    );
    return;
  }
  const headers: Record<string, string> = {
    "Content-Type": obj.contentType ?? "application/octet-stream",
    "Content-Length": String(obj.body.byteLength),
    ETag: obj.etag,
  };
  res.writeHead(200, headers);
  if (headOnly) {
    res.end();
  } else {
    res.end(Buffer.from(obj.body));
  }
  journal.add({
    method: headOnly ? "HEAD" : "GET",
    path: req.url ?? `/s3/${bucket}/${key}`,
    headers: flattenHeaders(req.headers),
    body: null,
    response: { status: 200, fixture: null, source: "internal" },
    service: "s3",
  });
}

function handleDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsed: ParsedS3Path,
  state: S3State,
  journal: Journal,
): void {
  const { bucket, key } = parsed;
  state.delete(bucket, key);
  res.writeHead(204);
  res.end();
  journal.add({
    method: "DELETE",
    path: req.url ?? `/s3/${bucket}/${key}`,
    headers: flattenHeaders(req.headers),
    body: null,
    response: { status: 204, fixture: null, source: "internal" },
    service: "s3",
  });
}
