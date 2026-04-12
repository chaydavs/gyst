import { describe, test, expect } from "bun:test";
import {
  stripSensitiveData,
  containsSensitiveData,
} from "../../src/compiler/security.js";

// ---------------------------------------------------------------------------
// stripSensitiveData
// ---------------------------------------------------------------------------

describe("stripSensitiveData", () => {
  test("strips AWS access keys (AKIA...)", () => {
    const input = "Using key AKIAIOSFODNN7EXAMPLE to authenticate";
    const result = stripSensitiveData(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("strips AWS access keys exactly 20 chars after AKIA", () => {
    // AKIA + 16 uppercase alphanumeric = 20 char key
    const key = "AKIA1234567890ABCDEF";
    const result = stripSensitiveData(`aws_key=${key}`);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain(key);
  });

  test("strips PEM private key headers", () => {
    const input = "-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9";
    const result = stripSensitiveData(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("-----BEGIN PRIVATE KEY-----");
  });

  test("strips RSA private key headers", () => {
    const input = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA";
    const result = stripSensitiveData(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("-----BEGIN RSA PRIVATE KEY-----");
  });

  test("strips EC private key headers", () => {
    const input = "-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIOaR";
    const result = stripSensitiveData(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("-----BEGIN EC PRIVATE KEY-----");
  });

  test("strips postgres connection strings", () => {
    const input = "db = postgres://admin:s3cr3t@db.example.com:5432/mydb";
    const result = stripSensitiveData(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("postgres://admin:s3cr3t@db.example.com:5432/mydb");
  });

  test("strips mongodb connection strings", () => {
    const input = "mongodb://user:password@cluster.mongodb.net/prod";
    const result = stripSensitiveData(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("mongodb://user:password");
  });

  test("strips mysql connection strings", () => {
    const input = "mysql://root:password@localhost:3306/db";
    const result = stripSensitiveData(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("mysql://root:password");
  });

  test("strips redis connection strings", () => {
    const input = "redis://:password@redis-host:6379/0";
    const result = stripSensitiveData(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("redis://:password");
  });

  test("strips JWT tokens (eyJ...)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = stripSensitiveData(`Authorization: Bearer ${jwt}`);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("eyJhbGci");
  });

  test("strips api_key=value patterns", () => {
    const input = `config = { api_key: "sk-abcdefghijklmnopqrstuvwxyz123456" }`;
    const result = stripSensitiveData(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  test("strips token=value patterns", () => {
    const input = `token = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"`;
    const result = stripSensitiveData(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  });

  test("strips password=value patterns", () => {
    const input = `password="supersecretpassword123"`;
    const result = stripSensitiveData(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("supersecretpassword123");
  });

  test("does NOT strip normal code content", () => {
    const input = `function greet(name: string): string {
  return "Hello, " + name;
}`;
    const result = stripSensitiveData(input);
    expect(result).toBe(input);
  });

  test("does NOT strip short assignment values", () => {
    // api_key with value shorter than 8 chars should not be redacted
    const input = `key = "abc"`;
    const result = stripSensitiveData(input);
    // Short values are not matched — content stays intact
    expect(result).toBe(input);
  });

  test("strips multiple sensitive items in one string", () => {
    const input = [
      `aws_key=AKIAIOSFODNN7EXAMPLE`,
      `db=postgres://user:pass@host/db`,
      `token="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"`,
    ].join("\n");

    const result = stripSensitiveData(input);
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).not.toContain("postgres://user:pass@host/db");
    expect(result).not.toContain("ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(result.split("[REDACTED]").length).toBeGreaterThanOrEqual(3);
  });

  test("returns new string and does not mutate the original", () => {
    const original = "key AKIAIOSFODNN7EXAMPLE here";
    const copy = original;
    const result = stripSensitiveData(original);
    expect(original).toBe(copy); // original unchanged
    expect(result).not.toBe(original);
  });

  test("returns original string unchanged when no sensitive data present", () => {
    const input = "This is a normal log message with no secrets.";
    const result = stripSensitiveData(input);
    expect(result).toBe(input);
  });

  test("handles empty string input", () => {
    expect(stripSensitiveData("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// containsSensitiveData
// ---------------------------------------------------------------------------

describe("containsSensitiveData", () => {
  test("returns true for AWS access keys", () => {
    expect(containsSensitiveData("AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  test("returns true for JWT tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(containsSensitiveData(jwt)).toBe(true);
  });

  test("returns true for connection strings", () => {
    expect(
      containsSensitiveData("postgres://admin:secret@host/db"),
    ).toBe(true);
  });

  test("returns true for private key headers", () => {
    expect(
      containsSensitiveData("-----BEGIN PRIVATE KEY-----"),
    ).toBe(true);
  });

  test("returns true for api_key assignments", () => {
    expect(
      containsSensitiveData(`api_key = "some-long-api-key-value-here"`),
    ).toBe(true);
  });

  test("returns false for clean strings", () => {
    expect(containsSensitiveData("Normal error: null pointer exception")).toBe(
      false,
    );
  });

  test("returns false for empty string", () => {
    expect(containsSensitiveData("")).toBe(false);
  });

  test("returns false for regular code without secrets", () => {
    const code = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
    expect(containsSensitiveData(code)).toBe(false);
  });

  test("does NOT modify the input string", () => {
    const input = "AKIAIOSFODNN7EXAMPLE";
    const copy = input;
    containsSensitiveData(input);
    expect(input).toBe(copy);
  });
});
