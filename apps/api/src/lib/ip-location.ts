import { isIP } from "node:net";
import { env } from "../config/env";
import { prisma } from "./prisma";
import { logger } from "./logger";

const LOOKUP_TIMEOUT_MS = 3_000;
// One Auditoria page shows up to 100 rows — new IPs beyond this many wait for the next page load.
const MAX_LOOKUPS_PER_REQUEST = 10;

export interface IpPlace {
  label: string;
  latitude: number;
  longitude: number;
}

/** Loopback, private, link-local and carrier-grade NAT ranges — an address inside the network, with no place. */
export function isInternalIp(ip: string): boolean {
  if (isIP(ip) === 6) return ip === "::1" || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

async function fetchPlace(ip: string) {
  const res = await fetch(`${env.IP_GEOLOCATION_URL}/${encodeURIComponent(ip)}?fields=success,city,region,country,latitude,longitude`, {
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  const body = (await res.json()) as { success: boolean; city?: string; region?: string; country?: string; latitude?: number; longitude?: number };
  return body.success
    ? { found: true, city: body.city ?? null, region: body.region ?? null, country: body.country ?? null, latitude: body.latitude ?? null, longitude: body.longitude ?? null }
    : { found: false, city: null, region: null, country: null, latitude: null, longitude: null };
}

/**
 * The approximate place (city, state, country) of each public IP, from the cache or looked up once. Internal IPs and
 * IPs the service doesn't know map to null; an IP whose lookup failed this time (service down) is tried again later.
 */
export async function getIpPlaces(ips: string[]): Promise<Map<string, IpPlace | null>> {
  const unique = [...new Set(ips)].filter((ip) => isIP(ip) && !isInternalIp(ip));
  const cached = await prisma.ipLocation.findMany({ where: { ip: { in: unique } } });
  const byIp = new Map(cached.map((row) => [row.ip, row]));
  const missing = env.IP_GEOLOCATION_URL ? unique.filter((ip) => !byIp.has(ip)).slice(0, MAX_LOOKUPS_PER_REQUEST) : [];
  await Promise.all(
    missing.map(async (ip) => {
      try {
        const place = await fetchPlace(ip);
        byIp.set(ip, await prisma.ipLocation.upsert({ where: { ip }, create: { ip, ...place }, update: { ...place, lookedUpAt: new Date() } }));
      } catch (err) {
        logger.warn({ err, ip }, "could not look up the place of an IP");
      }
    })
  );
  const result = new Map<string, IpPlace | null>();
  for (const [ip, row] of byIp) {
    if (!row.found || row.latitude === null || row.longitude === null) continue;
    const label = [row.city, row.region, row.country].filter(Boolean).join(", ");
    result.set(ip, { label, latitude: row.latitude, longitude: row.longitude });
  }
  return result;
}
