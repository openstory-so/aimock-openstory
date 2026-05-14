import { describe, test, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMock } from "../llmock.js";
import {
  fingerprintHash,
  fixturePath as s3FixturePath,
  writeFixture,
  type S3FixtureResponse,
} from "../s3-recorder.js";

interface CapturedUpstreamPut {
  method?: string;
  path?: string;
  authorization?: string;
  amzDate?: string;
  amzContentSha256?: string;
  contentType?: string;
  body: Buffer;
}

/** Spin up a tiny HTTP server that captures one PUT and replies with a fake ETag. */
function startUpstreamStub(): Promise<{
  url: string;
  captured: CapturedUpstreamPut[];
  stop(): Promise<void>;
}> {
  const captured: CapturedUpstreamPut[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured.push({
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization,
        amzDate: req.headers["x-amz-date"] as string | undefined,
        amzContentSha256: req.headers["x-amz-content-sha256"] as string | undefined,
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks),
      });
      res.writeHead(200, { ETag: '"upstream-etag-abc"' });
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        captured,
        stop: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe("S3 mock handler", () => {
  let mock: LLMock;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "aimock-s3-"));
  });

  afterEach(async () => {
    if (mock) {
      try {
        await mock.stop();
      } catch {
        // already stopped
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("disabled by default — /s3 returns 404", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    const res = await fetch(`${mock.url}/s3/thumbnails/foo.png`, { method: "PUT", body: "x" });
    expect(res.status).toBe(404);
  });

  test("live mode: PUT then GET round-trips bytes", async () => {
    mock = new LLMock({ port: 0, s3: { enabled: true, mode: "live" } });
    await mock.start();

    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const putRes = await fetch(`${mock.url}/s3/thumbnails/01HX/cover.png`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body,
    });
    expect(putRes.status).toBe(200);
    expect(putRes.headers.get("etag")).toMatch(/^"mock-[0-9a-f]+"$/);

    const getRes = await fetch(`${mock.url}/s3/thumbnails/01HX/cover.png`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("image/png");
    expect(getRes.headers.get("content-length")).toBe("5");
    const buf = new Uint8Array(await getRes.arrayBuffer());
    expect(Array.from(buf)).toEqual([1, 2, 3, 4, 5]);
  });

  test("HEAD returns headers without body", async () => {
    mock = new LLMock({ port: 0, s3: { enabled: true, mode: "live" } });
    await mock.start();

    await fetch(`${mock.url}/s3/videos/clip.mp4`, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: new Uint8Array([9, 9, 9]),
    });

    const head = await fetch(`${mock.url}/s3/videos/clip.mp4`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("video/mp4");
    expect(head.headers.get("content-length")).toBe("3");
    expect(head.headers.get("etag")).toBeTruthy();
  });

  test("GET on missing key returns 404 with NoSuchKey", async () => {
    mock = new LLMock({ port: 0, s3: { enabled: true, mode: "live" } });
    await mock.start();
    const res = await fetch(`${mock.url}/s3/thumbnails/missing.png`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("NoSuchKey");
  });

  test("DELETE removes object", async () => {
    mock = new LLMock({ port: 0, s3: { enabled: true, mode: "live" } });
    await mock.start();

    await fetch(`${mock.url}/s3/thumbnails/foo.png`, {
      method: "PUT",
      body: new Uint8Array([0]),
    });
    const del = await fetch(`${mock.url}/s3/thumbnails/foo.png`, { method: "DELETE" });
    expect(del.status).toBe(204);
    const after = await fetch(`${mock.url}/s3/thumbnails/foo.png`);
    expect(after.status).toBe(404);
  });

  test("malformed path (bucket only) returns 400", async () => {
    mock = new LLMock({ port: 0, s3: { enabled: true, mode: "live" } });
    await mock.start();
    const res = await fetch(`${mock.url}/s3/just-a-bucket`, { method: "PUT", body: "x" });
    expect(res.status).toBe(400);
  });

  test("record mode writes a metadata fixture to disk", async () => {
    mock = new LLMock({
      port: 0,
      s3: { enabled: true, mode: "record", fixtureDir: tmpDir },
    });
    await mock.start();

    const body = new Uint8Array([7, 7, 7, 7]);
    const res = await fetch(`${mock.url}/s3/thumbnails/teams/01HX/cover.png`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body,
    });
    expect(res.status).toBe(200);

    const fp = {
      bucket: "thumbnails",
      key: "teams/01HX/cover.png",
      contentType: "image/png",
    };
    const expectedPath = s3FixturePath(tmpDir, fp, fingerprintHash(fp));
    expect(existsSync(expectedPath)).toBe(true);

    const fixture = JSON.parse(readFileSync(expectedPath, "utf-8"));
    expect(fixture.request.bucket).toBe("thumbnails");
    expect(fixture.request.key).toBe("teams/01HX/cover.png");
    expect(fixture.request.contentType).toBe("image/png");
    expect(fixture.request.bodySize).toBe(4);
    expect(fixture.request.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.response.status).toBe(200);
    expect(fixture.response.etag).toMatch(/^"mock-[0-9a-f]+"$/);
  });

  test("replay mode returns recorded response on PUT and serves cached body on GET", async () => {
    // Pre-populate a fixture that aimock can replay against
    const fp = {
      bucket: "videos",
      key: "teams/01ABCDEFGHJKMNPQRSTVWXYZ12/render/foo.mp4",
      contentType: "video/mp4",
    };
    const recordedResp: S3FixtureResponse = {
      status: 200,
      etag: '"recorded-etag-123"',
      publicUrl: "https://cdn.example.com/videos/replay.mp4",
    };
    writeFixture(tmpDir, fp, new Uint8Array([1, 2, 3]), recordedResp);

    mock = new LLMock({
      port: 0,
      s3: { enabled: true, mode: "replay", fixtureDir: tmpDir },
    });
    await mock.start();

    // Use a DIFFERENT ULID in the live key — fingerprint normalises to <ULID>
    // so it should still match the recorded fixture.
    const livePath = "/s3/videos/teams/01ZZZZZZZZZZZZZZZZZZZZZZZZ/render/foo.mp4";
    const putRes = await fetch(`${mock.url}${livePath}`, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: new Uint8Array([4, 5, 6]),
    });
    expect(putRes.status).toBe(200);
    expect(putRes.headers.get("etag")).toBe('"recorded-etag-123"');
    expect(putRes.headers.get("x-llmock-s3-public-url")).toBe(
      "https://cdn.example.com/videos/replay.mp4",
    );

    // After PUT, the live body is cached in state — GET serves it back.
    const getRes = await fetch(`${mock.url}${livePath}`);
    expect(getRes.status).toBe(200);
    const got = new Uint8Array(await getRes.arrayBuffer());
    expect(Array.from(got)).toEqual([4, 5, 6]);
  });

  test("replay mode 503s on fingerprint miss", async () => {
    mock = new LLMock({
      port: 0,
      s3: { enabled: true, mode: "replay", fixtureDir: tmpDir },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/s3/thumbnails/nope.png`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array([0]),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.type).toBe("fixture_miss");
  });

  test("putS3Object pre-populates state for GETs", async () => {
    mock = new LLMock({ port: 0, s3: { enabled: true, mode: "live" } });
    await mock.start();
    mock.putS3Object("thumbnails", "preset/banner.png", "hello-world", {
      contentType: "image/png",
    });

    const res = await fetch(`${mock.url}/s3/thumbnails/preset/banner.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("hello-world");
  });

  test("reset() clears S3 state", async () => {
    mock = new LLMock({ port: 0, s3: { enabled: true, mode: "live" } });
    await mock.start();
    await fetch(`${mock.url}/s3/thumbnails/x.png`, {
      method: "PUT",
      body: new Uint8Array([1]),
    });
    expect((await fetch(`${mock.url}/s3/thumbnails/x.png`)).status).toBe(200);

    mock.reset();
    expect((await fetch(`${mock.url}/s3/thumbnails/x.png`)).status).toBe(404);
  });

  test("mode defaults to 'record' when record config is set", async () => {
    mock = new LLMock({
      port: 0,
      s3: { enabled: true, fixtureDir: tmpDir },
      record: { providers: { openai: "https://api.openai.com" }, fixturePath: tmpDir },
    });
    await mock.start();

    await fetch(`${mock.url}/s3/thumbnails/auto.png`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array([2, 2]),
    });

    const fp = { bucket: "thumbnails", key: "auto.png", contentType: "image/png" };
    expect(existsSync(s3FixturePath(tmpDir, fp, fingerprintHash(fp)))).toBe(true);
  });

  test("record mode forwards PUT to upstream with SigV4 signature and persists upstream etag", async () => {
    const stub = await startUpstreamStub();
    try {
      mock = new LLMock({
        port: 0,
        s3: {
          enabled: true,
          mode: "record",
          fixtureDir: tmpDir,
          upstream: {
            endpoint: stub.url,
            accessKeyId: "AKIAEXAMPLE",
            secretAccessKey: "secret-example-key",
          },
          publicUrlBuilder: ({ bucket, key }) => `https://cdn.example.com/${bucket}/${key}`,
        },
      });
      await mock.start();

      const body = new Uint8Array([1, 2, 3, 4, 5]);
      const res = await fetch(`${mock.url}/s3/thumbnails/01HX/cover.png`, {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBe('"upstream-etag-abc"');
      expect(res.headers.get("x-llmock-s3-public-url")).toBe(
        "https://cdn.example.com/thumbnails/01HX/cover.png",
      );

      // Upstream captured a signed PUT with our body bytes
      expect(stub.captured).toHaveLength(1);
      const got = stub.captured[0];
      expect(got.method).toBe("PUT");
      expect(got.path).toBe("/thumbnails/01HX/cover.png");
      expect(got.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
      expect(got.authorization).toContain("SignedHeaders=");
      expect(got.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
      expect(got.amzDate).toMatch(/^\d{8}T\d{6}Z$/);
      expect(got.amzContentSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(got.contentType).toBe("image/png");
      expect(Array.from(got.body)).toEqual([1, 2, 3, 4, 5]);

      // Fixture persisted the upstream etag and publicUrl
      const fp = { bucket: "thumbnails", key: "01HX/cover.png", contentType: "image/png" };
      const fixturePath = s3FixturePath(tmpDir, fp, fingerprintHash(fp));
      const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
      expect(fixture.response.etag).toBe('"upstream-etag-abc"');
      expect(fixture.response.publicUrl).toBe("https://cdn.example.com/thumbnails/01HX/cover.png");
    } finally {
      await stub.stop();
    }
  });

  test("record mode surfaces upstream 4xx instead of swallowing it", async () => {
    // Stub that returns 403 — simulates auth failure against real R2
    const server = http.createServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/xml" });
      res.end("<Error><Code>AccessDenied</Code></Error>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      mock = new LLMock({
        port: 0,
        s3: {
          enabled: true,
          mode: "record",
          fixtureDir: tmpDir,
          upstream: {
            endpoint: `http://127.0.0.1:${port}`,
            accessKeyId: "k",
            secretAccessKey: "s",
          },
        },
      });
      await mock.start();

      const res = await fetch(`${mock.url}/s3/thumbnails/forbidden.png`, {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: new Uint8Array([0]),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("AccessDenied");

      // No fixture written on upstream failure
      const fp = { bucket: "thumbnails", key: "forbidden.png", contentType: "image/png" };
      expect(existsSync(s3FixturePath(tmpDir, fp, fingerprintHash(fp)))).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("record mode without upstream falls back to local-only fixture write", async () => {
    // No upstream configured → record mode persists fixture with synthesised etag
    mock = new LLMock({
      port: 0,
      s3: { enabled: true, mode: "record", fixtureDir: tmpDir },
    });
    await mock.start();
    const res = await fetch(`${mock.url}/s3/thumbnails/local-only.png`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array([9, 9]),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^"mock-[0-9a-f]+"$/);

    const fp = { bucket: "thumbnails", key: "local-only.png", contentType: "image/png" };
    expect(existsSync(s3FixturePath(tmpDir, fp, fingerprintHash(fp)))).toBe(true);
  });

  test("405 for unsupported methods", async () => {
    mock = new LLMock({ port: 0, s3: { enabled: true, mode: "live" } });
    await mock.start();
    const res = await fetch(`${mock.url}/s3/thumbnails/x.png`, { method: "POST", body: "x" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("PUT");
  });
});
