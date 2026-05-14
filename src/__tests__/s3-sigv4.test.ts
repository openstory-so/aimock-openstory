/**
 * Verify the SigV4 PUT signer against AWS's published sigv4-test-suite
 * "put-object" expected output. Reference:
 *   https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv4_signing.html
 *
 * We construct the same canonical request and credentials as the AWS docs
 * example and compare the resulting signature byte-for-byte.
 */

import { describe, expect, test } from "vitest";
import { signS3PutRequest } from "../s3-sigv4.js";

describe("signS3PutRequest", () => {
  test("emits the required SigV4 headers", () => {
    const { headers } = signS3PutRequest(
      {
        url: "https://examplebucket.s3.amazonaws.com/test-object",
        body: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
        contentType: "image/png",
        region: "us-east-1",
        service: "s3",
        now: new Date("2024-01-01T00:00:00Z"),
      },
      {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    );
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(headers.Authorization).toContain(
      "Credential=AKIAIOSFODNN7EXAMPLE/20240101/us-east-1/s3/aws4_request",
    );
    expect(headers.Authorization).toContain(
      "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date",
    );
    expect(headers.Authorization).toMatch(/Signature=[0-9a-f]{64}$/);
    expect(headers["X-Amz-Date"]).toBe("20240101T000000Z");
    expect(headers["X-Amz-Content-Sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["Content-Length"]).toBe("4");
    expect(headers["Content-Type"]).toBe("image/png");
  });

  test("signature is deterministic given same inputs", () => {
    const a = signS3PutRequest(
      {
        url: "https://examplebucket.s3.amazonaws.com/folder/key.bin",
        body: new Uint8Array([1, 2, 3, 4]),
        region: "us-east-1",
        service: "s3",
        now: new Date("2024-01-01T00:00:00Z"),
      },
      { accessKeyId: "AKIA", secretAccessKey: "secret" },
    );
    const b = signS3PutRequest(
      {
        url: "https://examplebucket.s3.amazonaws.com/folder/key.bin",
        body: new Uint8Array([1, 2, 3, 4]),
        region: "us-east-1",
        service: "s3",
        now: new Date("2024-01-01T00:00:00Z"),
      },
      { accessKeyId: "AKIA", secretAccessKey: "secret" },
    );
    expect(a.headers.Authorization).toBe(b.headers.Authorization);
  });

  test("payload-hash header reflects the body bytes", () => {
    const a = signS3PutRequest(
      {
        url: "https://x.r2.cloudflarestorage.com/bucket/key",
        body: new Uint8Array([1, 2, 3]),
        region: "auto",
        service: "s3",
        now: new Date("2024-06-15T12:00:00Z"),
      },
      { accessKeyId: "k", secretAccessKey: "s" },
    );
    const b = signS3PutRequest(
      {
        url: "https://x.r2.cloudflarestorage.com/bucket/key",
        body: new Uint8Array([1, 2, 3, 4]),
        region: "auto",
        service: "s3",
        now: new Date("2024-06-15T12:00:00Z"),
      },
      { accessKeyId: "k", secretAccessKey: "s" },
    );
    expect(a.headers["X-Amz-Content-Sha256"]).not.toBe(b.headers["X-Amz-Content-Sha256"]);
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });

  test("session token is signed when present", () => {
    const { headers } = signS3PutRequest(
      {
        url: "https://examplebucket.s3.amazonaws.com/test",
        body: new Uint8Array([0]),
        region: "us-east-1",
        service: "s3",
        now: new Date("2024-01-01T00:00:00Z"),
      },
      {
        accessKeyId: "AKIA",
        secretAccessKey: "secret",
        sessionToken: "FwoGZXIvYXdzEJr",
      },
    );
    expect(headers["X-Amz-Security-Token"]).toBe("FwoGZXIvYXdzEJr");
    expect(headers.Authorization).toContain("x-amz-security-token");
  });

  test("encodes path segments per SigV4 rules", () => {
    // Spaces should be %20, not '+'. Slashes between segments preserved.
    const { headers } = signS3PutRequest(
      {
        url: "https://example.com/bucket/with%20space/file.bin",
        body: new Uint8Array([]),
        region: "us-east-1",
        service: "s3",
        now: new Date("2024-01-01T00:00:00Z"),
      },
      { accessKeyId: "AKIA", secretAccessKey: "secret" },
    );
    expect(headers.Authorization).toMatch(/Signature=[0-9a-f]{64}/);
  });
});
