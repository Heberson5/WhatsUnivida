import { createHash, createHmac } from "node:crypto";
import type { SmsProviderId } from "@whatsatendende/types";

/**
 * One function per SMS provider: sends `text` to `phone` (digits with country code, e.g. 5565999286623) and throws a
 * readable error when the provider refuses. Only fetch — no provider SDK — so adding one is a few lines here.
 */

export type SmsConfig = Record<string, string>;

const TIMEOUT_MS = 15_000;

async function call(url: string, init: RequestInit): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, text };
  } catch (err) {
    throw new Error(controller.signal.aborted ? "O provedor de SMS não respondeu a tempo" : `Não foi possível falar com o provedor de SMS: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function ensureOk(res: { status: number; text: string }, provider: string): string {
  if (res.status >= 200 && res.status < 300) return res.text;
  throw new Error(`${provider} recusou o envio (HTTP ${res.status}): ${res.text.slice(0, 300)}`);
}

function required(config: SmsConfig, ...keys: string[]): void {
  const missing = keys.filter((k) => !config[k]?.trim());
  if (missing.length) throw new Error(`Preencha: ${missing.join(", ")}`);
}

/** Brazilian numbers without the country code get 55 — every provider below wants the full international number. */
export function normalizeSmsPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

async function zenvia(c: SmsConfig, to: string, text: string) {
  required(c, "token", "from");
  ensureOk(
    await call("https://api.zenvia.com/v2/channels/sms/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-TOKEN": c.token },
      body: JSON.stringify({ from: c.from, to, contents: [{ type: "text", text }] }),
    }),
    "Zenvia"
  );
}

async function twilio(c: SmsConfig, to: string, text: string) {
  required(c, "accountSid", "authToken", "from");
  const sender: Record<string, string> = c.from.startsWith("MG") ? { MessagingServiceSid: c.from } : { From: c.from };
  ensureOk(
    await call(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Messages.json`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic(c.accountSid, c.authToken) },
      body: form({ To: `+${to}`, Body: text, ...sender }),
    }),
    "Twilio"
  );
}

async function comtele(c: SmsConfig, to: string, text: string) {
  required(c, "authKey");
  const body = ensureOk(
    await call("https://sms.comtele.com.br/api/v2/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "auth-key": c.authKey },
      body: JSON.stringify({ Sender: "alerta", Receivers: to.replace(/^55/, ""), Content: text }),
    }),
    "Comtele"
  );
  if (/"Success"\s*:\s*false/i.test(body)) throw new Error(`Comtele recusou o envio: ${body.slice(0, 300)}`);
}

async function mobizon(c: SmsConfig, to: string, text: string) {
  required(c, "apiKey");
  const server = (c.apiServer || "api.mobizon.com.br").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const body = ensureOk(
    await call(`https://${server}/service/message/sendsmsmessage?output=json&api=v1&apiKey=${encodeURIComponent(c.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ recipient: to, text, ...(c.from ? { from: c.from } : {}) }),
    }),
    "Mobizon"
  );
  const code = /"code"\s*:\s*(\d+)/.exec(body)?.[1];
  if (code && code !== "0") throw new Error(`Mobizon recusou o envio: ${body.slice(0, 300)}`);
}

async function totalvoice(c: SmsConfig, to: string, text: string) {
  required(c, "accessToken");
  const body = ensureOk(
    await call("https://api2.totalvoice.com.br/sms", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Access-Token": c.accessToken },
      body: JSON.stringify({ numero_destino: to.replace(/^55/, ""), mensagem: text }),
    }),
    "TotalVoice"
  );
  if (/"sucesso"\s*:\s*false/i.test(body)) throw new Error(`TotalVoice recusou o envio: ${body.slice(0, 300)}`);
}

async function smsdev(c: SmsConfig, to: string, text: string) {
  required(c, "key");
  const body = ensureOk(
    await call(`https://api.smsdev.com.br/v1/send?${form({ key: c.key, type: "9", number: to.replace(/^55/, ""), msg: text })}`, { method: "GET" }),
    "SMSDev"
  );
  if (/"situacao"\s*:\s*"ERRO"/i.test(body)) throw new Error(`SMSDev recusou o envio: ${body.slice(0, 300)}`);
}

async function vonage(c: SmsConfig, to: string, text: string) {
  required(c, "apiKey", "apiSecret", "from");
  const body = ensureOk(
    await call("https://rest.nexmo.com/sms/json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ api_key: c.apiKey, api_secret: c.apiSecret, from: c.from, to, text, type: "unicode" }),
    }),
    "Vonage"
  );
  const status = /"status"\s*:\s*"(\d+)"/.exec(body)?.[1];
  if (status && status !== "0") throw new Error(`Vonage recusou o envio: ${body.slice(0, 300)}`);
}

/** Amazon SNS Publish, signed with AWS Signature Version 4 (no SDK). */
async function awsSns(c: SmsConfig, to: string, text: string, now = new Date()) {
  required(c, "accessKeyId", "secretAccessKey", "region");
  const region = c.region.trim();
  const host = `sns.${region}.amazonaws.com`;
  const params: Record<string, string> = { Action: "Publish", Version: "2010-03-31", PhoneNumber: `+${to}`, Message: text };
  if (c.senderId) {
    params["MessageAttributes.entry.1.Name"] = "AWS.SNS.SMS.SenderID";
    params["MessageAttributes.entry.1.Value.DataType"] = "String";
    params["MessageAttributes.entry.1.Value.StringValue"] = c.senderId;
  }
  const body = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const sha = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
  const hmac = (key: Buffer | string, v: string) => createHmac("sha256", key).update(v, "utf8").digest();
  const canonical = ["POST", "/", "", `content-type:application/x-www-form-urlencoded; charset=utf-8\nhost:${host}\nx-amz-date:${amzDate}\n`, "content-type;host;x-amz-date", sha(body)].join("\n");
  const scope = `${dateStamp}/${region}/sns/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, dateStamp), region), "sns"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(toSign, "utf8").digest("hex");
  ensureOk(
    await call(`https://${host}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        "X-Amz-Date": amzDate,
        Authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=content-type;host;x-amz-date, Signature=${signature}`,
      },
      body,
    }),
    "Amazon SNS"
  );
}

/** Any other provider with an HTTP API: the admin's own URL, headers and body, with {{numero}} and {{mensagem}}. */
async function genericHttp(c: SmsConfig, to: string, text: string) {
  required(c, "url");
  const method = (c.method || "POST").toUpperCase();
  const contentType = c.contentType || "application/json";
  const fill = (template: string, encode: (v: string) => string) => template.replace(/\{\{\s*numero\s*\}\}/gi, encode(to)).replace(/\{\{\s*mensagem\s*\}\}/gi, encode(text));
  const jsonEscape = (v: string) => JSON.stringify(v).slice(1, -1);
  const headers: Record<string, string> = {};
  for (const line of (c.headers ?? "").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const url = fill(c.url, encodeURIComponent);
  const init: RequestInit = { method, headers };
  if (method !== "GET") {
    headers["Content-Type"] ??= contentType;
    const encode = contentType === "application/json" ? jsonEscape : contentType === "application/x-www-form-urlencoded" ? encodeURIComponent : (v: string) => v;
    init.body = fill(c.body || '{"to":"{{numero}}","message":"{{mensagem}}"}', encode);
  }
  ensureOk(await call(url, init), "O provedor");
}

export const SMS_SENDERS: Record<SmsProviderId, (config: SmsConfig, to: string, text: string) => Promise<void>> = {
  ZENVIA: zenvia,
  TWILIO: twilio,
  COMTELE: comtele,
  MOBIZON: mobizon,
  TOTALVOICE: totalvoice,
  SMSDEV: smsdev,
  VONAGE: vonage,
  AWS_SNS: (c, to, text) => awsSns(c, to, text),
  GENERIC_HTTP: genericHttp,
};
