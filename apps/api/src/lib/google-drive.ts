import crypto from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { env } from "../config/env";
import { decryptSecret, encryptSecret } from "./crypto";
import { Errors, HttpError } from "./http-error";

/**
 * The Google Drive the backups go to (the administrator's own Google account).
 *
 * The system asks only for "drive.file": it sees and touches only the folders and files it created itself — the
 * rest of that Drive stays invisible to it. The authorization is given once, by an administrator, on
 * Configurações › Backup; the client secret and the refresh token are kept encrypted (lib/crypto.ts).
 *
 * Every system that uses the same Google account gets its own folder, named after its public address.
 *
 * The public address (what Google sends the administrator back to) is the one typed on the screen, else WEB_APP_URL.
 * Google only accepts an https address with a domain — never a bare IP or http, which is what WEB_APP_URL can hold
 * on a server reached by its IP (e.g. http://163.176.182.42:8080).
 */

const SETTING_KEY = "googleDrive";
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/drive.file"];
const FOLDER_MIME = "application/vnd.google-apps.folder";

interface StoredDrive {
  clientId: string | null;
  clientSecret: string | null; // encrypted
  refreshToken: string | null; // encrypted
  accountEmail: string | null;
  rootFolderId: string | null;
  connectedAt: string | null;
  lastError: string | null;
  /** The site's public address, typed on Configurações › Backup (https://domínio); null = WEB_APP_URL. */
  publicUrl: string | null;
}

const EMPTY: StoredDrive = { clientId: null, clientSecret: null, refreshToken: null, accountEmail: null, rootFolderId: null, connectedAt: null, lastError: null, publicUrl: null };

const CALLBACK_PATH = "/api/settings/backup/google-drive/callback";

/** Why Google would refuse this address as a redirect URI, or null when it is fine. */
export function addressProblem(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return "Informe o endereço completo do site, por exemplo https://whatsatendente.sauberlich.com.br";
  }
  const host = url.hostname;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
  if (host === "localhost" || host.endsWith(".localhost")) return null; // Google accepts it (development only)
  if (url.protocol !== "https:") return "O Google só aceita endereço com https://";
  if (isIp) return "O Google não aceita endereço por IP: use o domínio do site";
  if (!host.includes(".")) return "Use o domínio completo do site";
  return null;
}

/** The site's address as typed (only scheme, host and port), or an error saying what is wrong with it. */
export function normalizePublicUrl(raw: string): string {
  const problem = addressProblem(raw.trim());
  if (problem) throw Errors.badRequest(problem);
  return new URL(raw.trim()).origin;
}

const baseUrl = (stored: StoredDrive) => (stored.publicUrl ?? env.WEB_APP_URL).replace(/\/$/, "");
const redirectUriOf = (stored: StoredDrive) => `${baseUrl(stored)}${CALLBACK_PATH}`;

/** The site's public address in use (where the browser goes back after authorizing). */
export async function publicBaseUrl(): Promise<string> {
  return baseUrl(await load());
}

export class DriveError extends HttpError {
  constructor(message: string, public readonly disconnected = false) {
    super(disconnected ? 409 : 502, disconnected ? "DRIVE_DISCONNECTED" : "DRIVE_ERROR", message);
  }
}

async function load(): Promise<StoredDrive> {
  const row = await prisma.systemSetting.findUnique({ where: { key: SETTING_KEY } });
  return { ...EMPTY, ...((row?.value as Partial<StoredDrive> | undefined) ?? {}) };
}

async function save(patch: Partial<StoredDrive>): Promise<StoredDrive> {
  const next = { ...(await load()), ...patch };
  await prisma.systemSetting.upsert({
    where: { key: SETTING_KEY },
    update: { value: next as unknown as Prisma.InputJsonValue },
    create: { key: SETTING_KEY, value: next as unknown as Prisma.InputJsonValue },
  });
  return next;
}

export async function driveStatus() {
  const stored = await load();
  return {
    configured: Boolean(stored.clientId && stored.clientSecret),
    connected: Boolean(stored.refreshToken),
    clientId: stored.clientId,
    accountEmail: stored.accountEmail,
    connectedAt: stored.connectedAt,
    lastError: stored.lastError,
    // Where Google sends the administrator back after authorizing — registered as is in the Google Cloud project.
    redirectUri: redirectUriOf(stored),
    publicUrl: stored.publicUrl,
    defaultUrl: env.WEB_APP_URL.replace(/\/$/, ""),
    addressProblem: addressProblem(baseUrl(stored)),
    folderName: folderName(stored),
  };
}

export async function setDriveCredentials(clientId: string, clientSecret: string | undefined, publicUrl?: string | null) {
  const stored = await load();
  const changedClient = stored.clientId !== clientId;
  await save({
    clientId,
    ...(publicUrl !== undefined ? { publicUrl: publicUrl === null || publicUrl === "" ? null : normalizePublicUrl(publicUrl) } : {}),
    ...(clientSecret ? { clientSecret: encryptSecret(clientSecret) } : {}),
    // Another Google Cloud project: the old authorization is no longer valid.
    ...(changedClient ? { refreshToken: null, accountEmail: null, rootFolderId: null, connectedAt: null } : {}),
  });
  return driveStatus();
}

// The "state" Google hands back: proves the callback answers an authorization this server started, for this administrator.
function sign(payload: string) {
  return crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update(`drive:${payload}`).digest("base64url");
}

export async function authorizationUrl(userId: string): Promise<string> {
  const stored = await load();
  if (!stored.clientId || !stored.clientSecret) throw new DriveError("Informe o ID e a chave secreta do cliente OAuth antes de conectar");
  const problem = addressProblem(baseUrl(stored));
  if (problem) throw Errors.badRequest(`Endereço do site: ${problem}. Informe-o em Configurações › Backup e salve.`);
  const payload = Buffer.from(JSON.stringify({ u: userId, exp: Date.now() + 15 * 60_000, n: crypto.randomUUID() })).toString("base64url");
  const params = new URLSearchParams({
    client_id: stored.clientId,
    redirect_uri: redirectUriOf(stored),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    // Always shows the consent, so Google always hands back a refresh token (it doesn't on a second authorization).
    prompt: "consent",
    include_granted_scopes: "true",
    state: `${payload}.${sign(payload)}`,
  });
  return `${env.GOOGLE_AUTH_URL}?${params}`;
}

/** Google's redirect after the administrator authorized: trades the code for a refresh token. Returns their id. */
export async function completeAuthorization(code: string, state: string): Promise<{ userId: string; accountEmail: string | null }> {
  const [payload, signature] = state.split(".");
  const expected = payload ? sign(payload) : "";
  if (!payload || !signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new DriveError("Autorização inválida. Tente conectar de novo.");
  }
  const { u, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u: string; exp: number };
  if (Date.now() > exp) throw new DriveError("A autorização demorou demais. Tente conectar de novo.");
  const stored = await load();
  if (!stored.clientId || !stored.clientSecret) throw new DriveError("Credenciais do Google não configuradas");
  const res = await fetch(env.GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: stored.clientId,
      client_secret: decryptSecret(stored.clientSecret),
      redirect_uri: redirectUriOf(stored),
      grant_type: "authorization_code",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string; expires_in?: number; id_token?: string; error_description?: string };
  if (!res.ok || !body.refresh_token) throw new DriveError(`O Google recusou a autorização${body.error_description ? `: ${body.error_description}` : ""}`);
  let accountEmail: string | null = null;
  try {
    accountEmail = body.id_token ? (JSON.parse(Buffer.from(body.id_token.split(".")[1], "base64url").toString("utf8")) as { email?: string }).email ?? null : null;
  } catch {
    accountEmail = null;
  }
  tokenCache = body.access_token ? { token: body.access_token, expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 } : null;
  await save({ refreshToken: encryptSecret(body.refresh_token), accountEmail, connectedAt: new Date().toISOString(), lastError: null, rootFolderId: null });
  return { userId: u, accountEmail };
}

export async function disconnectDrive() {
  const stored = await load();
  if (stored.refreshToken) {
    await fetch(`${env.GOOGLE_REVOKE_URL}?token=${encodeURIComponent(decryptSecret(stored.refreshToken))}`, { method: "POST" }).catch(() => undefined);
  }
  tokenCache = null;
  // The folder was in that Drive: the next backup creates it in the one connected then.
  await save({ refreshToken: null, accountEmail: null, rootFolderId: null, connectedAt: null });
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  const stored = await load();
  if (!stored.refreshToken || !stored.clientId || !stored.clientSecret) throw new DriveError("O Google Drive não está conectado", true);
  const res = await fetch(env.GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: stored.clientId,
      client_secret: decryptSecret(stored.clientSecret),
      refresh_token: decryptSecret(stored.refreshToken),
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) {
    // Revoked (password changed, access removed in the Google account) or expired: needs an administrator again.
    const revoked = body.error === "invalid_grant";
    await save({ lastError: revoked ? "O Google retirou a autorização. Conecte o Google Drive de novo." : `Falha ao falar com o Google (${res.status})` });
    throw new DriveError(revoked ? "O Google retirou a autorização do Drive. Conecte o Google Drive de novo em Configurações › Backup." : "Não foi possível falar com o Google agora", revoked);
  }
  tokenCache = { token: body.access_token, expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 };
  return body.access_token;
}

async function api(pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${env.GOOGLE_API_URL}${pathAndQuery}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${await accessToken()}` } });
  if (res.status === 401) tokenCache = null;
  return res;
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new DriveError(`Google Drive: falha ao ${what} (${res.status}${text ? `: ${text.slice(0, 200)}` : ""})`);
  }
  return (await res.json()) as T;
}

const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** A folder by name inside `parentId` ("root" = the top of the Drive), created when missing. */
export async function ensureFolder(name: string, parentId: string): Promise<string> {
  const q = `name = '${escape(name)}' and '${escape(parentId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const found = await json<{ files: { id: string }[] }>(await api(`/drive/v3/files?${new URLSearchParams({ q, fields: "files(id)", spaces: "drive" })}`), "procurar a pasta");
  if (found.files[0]) return found.files[0].id;
  const created = await json<{ id: string }>(
    await api(`/drive/v3/files?fields=id`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }) }),
    "criar a pasta"
  );
  return created.id;
}

/** Whether a folder the system created is still there (not deleted or emptied from the trash). */
async function folderExists(id: string): Promise<boolean> {
  const res = await api(`/drive/v3/files/${encodeURIComponent(id)}?fields=id,trashed`);
  if (res.status === 404) return false;
  const body = await json<{ trashed?: boolean }>(res, "abrir a pasta");
  return !body.trashed;
}

/** This system's folder at the top of the Drive: "Backups — <address>", so two systems on one account never mix. */
export function folderName(stored: StoredDrive): string {
  let host = baseUrl(stored);
  try {
    host = new URL(host).host;
  } catch {
    // Not a URL: the text as it is.
  }
  return `Backups — ${host}`;
}

/** This system's backups folder on the Drive — remembered, and created again if someone deleted it. */
export async function backupsFolder(): Promise<string> {
  const stored = await load();
  if (stored.rootFolderId && (await folderExists(stored.rootFolderId))) return stored.rootFolderId;
  const id = await ensureFolder(folderName(stored), "root");
  await save({ rootFolderId: id });
  return id;
}

export interface DriveFile {
  id: string;
  name: string;
  size: number;
  createdTime: string;
}

/** Sends a local file to a folder (resumable upload: works for files of any size). */
export async function uploadFile(localPath: string, name: string, parentId: string): Promise<DriveFile> {
  const size = fs.statSync(localPath).size;
  const start = await api(`/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,createdTime`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "application/octet-stream", "X-Upload-Content-Length": String(size) },
    body: JSON.stringify({ name, parents: [parentId], mimeType: "application/octet-stream" }),
  });
  if (!start.ok) await json(start, "começar o envio");
  const location = start.headers.get("location");
  if (!location) throw new DriveError("Google Drive: o envio não começou");
  const res = await fetch(location, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size), Authorization: `Bearer ${await accessToken()}` },
    body: Readable.toWeb(fs.createReadStream(localPath)) as unknown as RequestInit["body"],
    duplex: "half",
  } as RequestInit);
  const file = await json<{ id: string; name: string; size?: string; createdTime?: string }>(res, "enviar o arquivo");
  return { id: file.id, name: file.name, size: Number(file.size ?? size), createdTime: file.createdTime ?? new Date().toISOString() };
}

/** The backups in a folder, newest first. */
export async function listFiles(parentId: string): Promise<DriveFile[]> {
  const q = `'${escape(parentId)}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`;
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q, fields: "nextPageToken,files(id,name,size,createdTime)", orderBy: "createdTime desc", pageSize: "100", spaces: "drive" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await json<{ files: { id: string; name: string; size?: string; createdTime: string }[]; nextPageToken?: string }>(await api(`/drive/v3/files?${params}`), "listar os backups");
    files.push(...page.files.map((f) => ({ id: f.id, name: f.name, size: Number(f.size ?? 0), createdTime: f.createdTime })));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files.sort((a, b) => b.createdTime.localeCompare(a.createdTime));
}

export async function deleteFile(id: string): Promise<void> {
  const res = await api(`/drive/v3/files/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) await json(res, "apagar um backup antigo");
}

/** Brings a file from the Drive to a local (temporary) path. The file must be inside `parentId` (this system's folder). */
export async function downloadFile(id: string, parentId: string, target: string): Promise<DriveFile> {
  const meta = await json<{ id: string; name: string; size?: string; createdTime: string; parents?: string[] }>(
    await api(`/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,size,createdTime,parents`),
    "abrir o backup"
  );
  if (!meta.parents?.includes(parentId)) throw new DriveError("Este arquivo não é um backup deste sistema");
  const res = await api(`/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
  if (!res.ok || !res.body) await json(res, "baixar o backup");
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(target));
  return { id: meta.id, name: meta.name, size: Number(meta.size ?? 0), createdTime: meta.createdTime };
}

/** For the tests: forget the access token kept in memory. */
export function __resetDriveTokenForTests() {
  tokenCache = null;
}
