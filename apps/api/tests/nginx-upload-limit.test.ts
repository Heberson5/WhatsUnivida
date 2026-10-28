import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { env } from "../src/config/env";

// The web container's nginx sits in front of the API (docker-compose.yml): a
// request body over its client_max_body_size is refused with "413 Request
// Entity Too Large" before the API sees it. nginx's built-in default is 1 MB,
// which is what stopped every video — and any photo, PDF or audio over 1 MB —
// from being sent in Atendimento. The size the API accepts is its own
// UPLOAD_MAX_SIZE_MB, so nginx has to let at least that much through.
const NGINX_CONF = path.resolve(__dirname, "../../../infrastructure/docker/nginx.conf");

/** The text between the braces of `location <path> { ... }`, nested blocks included. */
function locationBlock(conf: string, location: string): string {
  const start = conf.indexOf(`location ${location} {`);
  if (start === -1) throw new Error(`location ${location} not found in nginx.conf`);
  let depth = 0;
  for (let i = conf.indexOf("{", start); i < conf.length; i++) {
    if (conf[i] === "{") depth++;
    if (conf[i] === "}" && --depth === 0) return conf.slice(conf.indexOf("{", start) + 1, i);
  }
  throw new Error(`location ${location} is never closed in nginx.conf`);
}

/** nginx's own default when a block doesn't set client_max_body_size. */
const NGINX_DEFAULT_MB = 1;

function bodyLimitMb(block: string): number {
  // Comments can mention the directive — only a real, uncommented line counts.
  const code = block
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  const match = code.match(/client_max_body_size\s+(\d+)([kmg])?\s*;/i);
  if (!match) return NGINX_DEFAULT_MB;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  if (unit === "k") return amount / 1024;
  if (unit === "m") return amount;
  if (unit === "g") return amount * 1024;
  return amount / (1024 * 1024); // bare number = bytes
}

describe("nginx.conf body limit for /api", () => {
  const conf = fs.readFileSync(NGINX_CONF, "utf-8");

  it("lets through at least as much as the API accepts for one upload", () => {
    expect(bodyLimitMb(locationBlock(conf, "/api"))).toBeGreaterThanOrEqual(env.UPLOAD_MAX_SIZE_MB);
  });

  it("keeps room for the highest limit the settings screen can set (100 MB)", () => {
    expect(bodyLimitMb(locationBlock(conf, "/api"))).toBeGreaterThanOrEqual(100);
  });

  it("lets through a Fontes de dados file of up to 300 MB", () => {
    expect(bodyLimitMb(locationBlock(conf, "/api"))).toBeGreaterThanOrEqual(300);
  });

  it("Configurações › Backup: no body limit and streamed both ways (a backup can be gigabytes)", () => {
    const block = locationBlock(conf, "/api/settings/backup");
    expect(block).toMatch(/client_max_body_size\s+0\s*;/);
    expect(block).toMatch(/proxy_request_buffering\s+off\s*;/);
    expect(block).toMatch(/proxy_buffering\s+off\s*;/);
    expect(block).toMatch(/proxy_pass\s+http:\/\/api:4000\s*;/);
  });

  it("is what the parser would call 1 MB if the directive were missing", () => {
    expect(bodyLimitMb("proxy_pass http://api:4000;")).toBe(1);
    expect(bodyLimitMb("# client_max_body_size 100m;\nproxy_pass http://api:4000;")).toBe(1);
    expect(bodyLimitMb("client_max_body_size 512k;")).toBe(0.5);
    expect(bodyLimitMb("client_max_body_size 2g;")).toBe(2048);
  });
});
