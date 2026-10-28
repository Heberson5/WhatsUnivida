import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { LinkPreviewDTO } from "@whatsatendende/types";
import { logger } from "../../lib/logger";

/**
 * Preview card (title, description, picture) for a link in a message. The
 * server fetches the page — never the browser — so the agent's address isn't
 * handed to the site and a link can't be used to probe the internal network:
 * every connection is checked at connect time against private/loopback/
 * link-local ranges (also on each redirect and after DNS resolution).
 */

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 300 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const USER_AGENT = "Mozilla/5.0 (compatible; LinkPreviewBot/1.0)";

export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped ? mapped[1] : address;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224
    );
  }
  const lower = ip.toLowerCase();
  return lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb");
}

const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      return callback(new Error("endereço não permitido"), "", 4);
    }
    if ((options as dns.LookupOptions).all) return callback(null, list as never, undefined as never);
    return callback(null, list[0].address, list[0].family);
  });
};

interface Fetched {
  status: number;
  contentType: string;
  body: Buffer;
  finalUrl: URL;
  location?: string;
}

function fetchOnce(url: URL, maxBytes: number): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      { method: "GET", lookup: safeLookup, timeout: REQUEST_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT, Accept: "text/html,image/*;q=0.8", "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.5" } },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            // Enough of the page (the tags we want are in <head>) — stop downloading.
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const done = () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? "").toLowerCase(),
            body: Buffer.concat(chunks),
            finalUrl: url,
            location: typeof res.headers.location === "string" ? res.headers.location : undefined,
          });
        res.on("end", done);
        res.on("close", done);
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function fetchFollowingRedirects(startUrl: URL, maxBytes: number): Promise<Fetched> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocolo não permitido");
    if (net.isIP(url.hostname) && isPrivateAddress(url.hostname)) throw new Error("endereço não permitido");
    const res = await fetchOnce(url, maxBytes);
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = new URL(res.location, url);
      continue;
    }
    return res;
  }
  throw new Error("redirecionamentos demais");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

function metaContent(html: string, keys: string[]): string | null {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const forward = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, "i").exec(html);
    const backward = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, "i").exec(html);
    const value = (forward ?? backward)?.[1]?.trim();
    if (value) return decodeEntities(value);
  }
  return null;
}

export function parsePreviewHtml(html: string): { title: string | null; description: string | null; image: string | null } {
  const head = html.slice(0, MAX_HTML_BYTES);
  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1]?.trim();
  return {
    title: metaContent(head, ["og:title", "twitter:title"]) ?? (titleTag ? decodeEntities(titleTag) : null),
    description: metaContent(head, ["og:description", "twitter:description", "description"]),
    image: metaContent(head, ["og:image", "twitter:image"]),
  };
}

async function fetchThumbnail(imageUrl: URL): Promise<string | null> {
  try {
    const res = await fetchFollowingRedirects(imageUrl, MAX_IMAGE_BYTES + 1);
    const type = res.contentType.split(";")[0].trim();
    if (res.status !== 200 || !IMAGE_TYPES.includes(type) || res.body.length === 0 || res.body.length > MAX_IMAGE_BYTES) return null;
    return `data:${type};base64,${res.body.toString("base64")}`;
  } catch {
    return null;
  }
}

const cache = new Map<string, { at: number; value: LinkPreviewDTO | null }>();

/** Null when the page has no usable title or can't be reached. */
export async function getLinkPreview(rawUrl: string): Promise<LinkPreviewDTO | null> {
  const cached = cache.get(rawUrl);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  let value: LinkPreviewDTO | null = null;
  try {
    const res = await fetchFollowingRedirects(new URL(rawUrl), MAX_HTML_BYTES);
    if (res.status === 200 && res.contentType.includes("text/html")) {
      const { title, description, image } = parsePreviewHtml(res.body.toString("utf-8"));
      if (title) {
        let thumbnailUrl: string | null = null;
        if (image) {
          try {
            thumbnailUrl = await fetchThumbnail(new URL(image, res.finalUrl));
          } catch {
            thumbnailUrl = null;
          }
        }
        value = { title, description, url: rawUrl, thumbnailUrl };
      }
    }
  } catch (err) {
    logger.debug({ err, url: rawUrl }, "link preview unavailable");
  }

  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(rawUrl, { at: Date.now(), value });
  return value;
}
