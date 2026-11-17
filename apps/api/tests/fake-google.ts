import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for Google (OAuth + Drive v3) on this machine — the tests never reach Google itself. Point the system at
 * it with env.GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL / GOOGLE_REVOKE_URL / GOOGLE_API_URL.
 */

export interface FakeFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  createdTime: string;
  data: Buffer;
  trashed: boolean;
}

export function fakeGoogle() {
  const files = new Map<string, FakeFile>();
  const pending = new Map<string, { name: string; parents: string[] }>();
  let next = 1;
  let clock = Date.parse("2027-01-01T00:00:00Z");
  const state = { revoked: false, authorizedCodes: new Set(["codigo-bom"]), tokenRequests: 0 };
  const read = (req: http.IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });
  const send = (res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const meta = (f: FakeFile) => ({ id: f.id, name: f.name, size: String(f.data.length), createdTime: f.createdTime, parents: f.parents, trashed: f.trashed });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const body = await read(req);
    if (url.pathname === "/token") {
      state.tokenRequests++;
      const form = new URLSearchParams(body.toString());
      if (form.get("grant_type") === "authorization_code") {
        if (!state.authorizedCodes.has(form.get("code") ?? "")) return send(res, 400, { error: "invalid_grant" });
        const idToken = `x.${Buffer.from(JSON.stringify({ email: "dono@gmail.com" })).toString("base64url")}.y`;
        return send(res, 200, { access_token: "acesso-1", refresh_token: "renovacao-1", expires_in: 3600, id_token: idToken });
      }
      if (state.revoked || form.get("refresh_token") !== "renovacao-1") return send(res, 400, { error: "invalid_grant" });
      return send(res, 200, { access_token: "acesso-2", expires_in: 3600 });
    }
    if (url.pathname === "/revoke") return send(res, 200, {});
    if (!/^Bearer acesso-/.test(req.headers.authorization ?? "")) return send(res, 401, { error: "unauthenticated" });
    if (url.pathname === "/upload/drive/v3/files" && req.method === "POST") {
      const metadata = JSON.parse(body.toString()) as { name: string; parents: string[] };
      const sid = `s${next++}`;
      pending.set(sid, metadata);
      return send(res, 200, {}, { Location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload-session/${sid}` });
    }
    if (url.pathname.startsWith("/upload-session/") && req.method === "PUT") {
      const metadata = pending.get(url.pathname.split("/").pop()!);
      if (!metadata) return send(res, 404, {});
      const file: FakeFile = { id: `f${next++}`, name: metadata.name, parents: metadata.parents, mimeType: "application/octet-stream", createdTime: new Date((clock += 60_000)).toISOString(), data: body, trashed: false };
      files.set(file.id, file);
      return send(res, 200, meta(file));
    }
    if (url.pathname === "/drive/v3/files" && req.method === "POST") {
      const metadata = JSON.parse(body.toString()) as { name: string; parents: string[]; mimeType: string };
      const file: FakeFile = { id: `d${next++}`, name: metadata.name, parents: metadata.parents, mimeType: metadata.mimeType, createdTime: new Date((clock += 1000)).toISOString(), data: Buffer.alloc(0), trashed: false };
      files.set(file.id, file);
      return send(res, 200, { id: file.id });
    }
    if (url.pathname === "/drive/v3/files" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const name = /name = '([^']+)'/.exec(q)?.[1];
      const folders = /mimeType = '([^']+)'/.exec(q)?.[1];
      const notFolders = /mimeType != '([^']+)'/.exec(q)?.[1];
      const found = [...files.values()]
        .filter((f) => !f.trashed && (!parent || f.parents.includes(parent)) && (!name || f.name === name) && (!folders || f.mimeType === folders) && (!notFolders || f.mimeType !== notFolders))
        .sort((a, b) => b.createdTime.localeCompare(a.createdTime));
      return send(res, 200, { files: found.map(meta) });
    }
    const match = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const file = files.get(decodeURIComponent(match[1]));
      if (!file) return send(res, 404, { error: "notFound" });
      if (req.method === "DELETE") {
        files.delete(file.id);
        return send(res, 204);
      }
      if (url.searchParams.get("alt") === "media") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(file.data);
      }
      return send(res, 200, meta(file));
    }
    send(res, 404, { error: "unknown" });
  });
  return { server, files, state };
}
