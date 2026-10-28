import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  ChatIdentityResolvedEvent,
  ChatReadEvent,
  ConnectOptions,
  ContactInfo,
  DeliveryEvent,
  GroupInfo,
  HistorySyncEvent,
  InboundMessageEvent,
  OutboundMenu,
  ReactionEvent,
  SendResult,
  SendTextOptions,
  WhatsAppProvider,
  WhatsAppStatusSnapshot,
} from "./types";

export interface CloudApiProviderOptions {
  phoneNumberId: string;
  accessToken: string;
  /** Overridable for tests — defaults to Meta's real Graph API. */
  graphApiBaseUrl?: string;
}

const DEFAULT_GRAPH_API_BASE_URL = "https://graph.facebook.com/v20.0";

export interface TemplateSendInput {
  name: string;
  language: string;
  headerParams: string[];
  headerMedia?: { kind: "image" | "video" | "document"; buffer: Buffer; fileName: string; mimeType: string };
  bodyParams: string[];
}

// What WhatsApp accepts in an interactive message (Cloud API).
const MAX_BUTTONS = 3;
const MAX_BUTTON_TITLE = 20;
export const MAX_LIST_ROWS = 10;
const MAX_ROW_TITLE = 24;
const MAX_ROW_DESCRIPTION = 72;
const MAX_INTERACTIVE_BODY = 1024;
const MAX_LIST_LABEL = 20;
const LONG_BODY_FOLLOW_UP = "Escolha uma opção 👇";

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

function digitsOnly(chatId: string): string {
  return chatId.replace(/\D/g, "");
}

/**
 * Real integration with Meta's WhatsApp Cloud API (the "WhatsApp Oficial"
 * connection type — see PROMPT: "inclua uma nova aba chamada WhatsApp
 * Oficial, para a conexão via API Oficial da Meta"). Implements the exact
 * same WhatsAppProvider seam BaileysWhatsAppProvider does — see that
 * class's own doc comment, which already anticipated this swap — so every
 * other module (whatsapp.service.ts's send/connect/disconnect, the queue,
 * conversations, messages) works completely unchanged for either kind of
 * connection.
 *
 * Fundamentally different runtime model than Baileys, though: there is no
 * persistent socket to hold open. "Connected" here means "the stored
 * phoneNumberId/accessToken were validated against the Graph API", and
 * inbound events arrive over Meta's webhook (a plain HTTPS POST into this
 * app), fed in here via ingestWebhookChange() — not pushed by this class
 * itself the way Baileys' WebSocket pushes events.
 *
 * Several WhatsAppProvider methods have no Cloud API equivalent at all
 * (Meta's Business Platform never exposes the linked number's phone
 * contact list, a generic "is this number on WhatsApp" lookup, or a bulk
 * history sync) — those are documented no-ops/empty results below, not
 * silently cut corners.
 */
export class CloudApiWhatsAppProvider implements WhatsAppProvider {
  // Only connection-status updates go through this — see
  // ingestWebhookChange's own comment for why message/delivery/reaction
  // dispatch deliberately does NOT use EventEmitter.emit: emit() invokes
  // listeners without awaiting them, so an async onMessage handler's actual
  // DB writes would still be in flight when ingestWebhookChange returns
  // (and the webhook route moves on) — invisible in production (nothing
  // downstream needed that ordering, since the route acks Meta immediately
  // either way), but exactly the kind of "silently still running" gap this
  // project avoids elsewhere (see sendWithTimeoutGuard's own reasoning).
  private emitter = new EventEmitter();
  private messageListeners: ((event: InboundMessageEvent) => void | Promise<void>)[] = [];
  private deliveryListeners: ((event: DeliveryEvent) => void | Promise<void>)[] = [];
  private reactionListeners: ((event: ReactionEvent) => void | Promise<void>)[] = [];
  private status: WhatsAppStatusSnapshot = {
    state: "DISCONNECTED",
    qrCodeDataUrl: null,
    pairingCode: null,
    connectedNumber: null,
    lastConnectedAt: null,
  };
  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly baseUrl: string;

  constructor(options: CloudApiProviderOptions) {
    this.phoneNumberId = options.phoneNumberId;
    this.accessToken = options.accessToken;
    this.baseUrl = options.graphApiBaseUrl ?? DEFAULT_GRAPH_API_BASE_URL;
  }

  /** Validates the stored credentials against the Graph API and resolves the real display number/business name — same check used by testConnection in whatsapp.service.ts. */
  async fetchPhoneNumberInfo(): Promise<{ displayPhoneNumber: string; businessName: string | null }> {
    const res = await fetch(`${this.baseUrl}/${this.phoneNumberId}?fields=display_phone_number,verified_name`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    const body = (await res.json().catch(() => null)) as { display_phone_number?: string; verified_name?: string; error?: { message?: string } } | null;
    if (!res.ok || !body?.display_phone_number) {
      throw new Error(body?.error?.message ?? `Nao foi possivel validar as credenciais da API Oficial (HTTP ${res.status})`);
    }
    return { displayPhoneNumber: body.display_phone_number, businessName: body.verified_name ?? null };
  }

  // No pairing/QR handshake exists for the Cloud API — "connecting" just
  // means checking the credentials are still valid. ConnectOptions is
  // ignored (it only ever carries Baileys' pairing-code phoneNumber).
  async connect(_options?: ConnectOptions): Promise<void> {
    this.setStatus({ ...this.status, state: "CONNECTING", qrCodeDataUrl: null, pairingCode: null });
    try {
      const info = await this.fetchPhoneNumberInfo();
      this.setStatus({
        state: "CONNECTED",
        qrCodeDataUrl: null,
        pairingCode: null,
        connectedNumber: info.displayPhoneNumber,
        lastConnectedAt: new Date(),
      });
    } catch (err) {
      this.setStatus({ state: "DISCONNECTED", qrCodeDataUrl: null, pairingCode: null, connectedNumber: null, lastConnectedAt: this.status.lastConnectedAt });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.setStatus({ state: "DISCONNECTED", qrCodeDataUrl: null, pairingCode: null, connectedNumber: null, lastConnectedAt: this.status.lastConnectedAt });
  }

  // No live socket to close gracefully — credentials-based, not session-based.
  async endForShutdown(): Promise<void> {}

  getStatus(): WhatsAppStatusSnapshot {
    return this.status;
  }

  private async graphPost(path: string, payload: unknown): Promise<{ messages?: { id: string }[] }> {
    const res = await fetch(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body as { error?: { message?: string } } | null)?.error?.message ?? `Falha ao enviar pela API Oficial (HTTP ${res.status})`);
    return body as { messages?: { id: string }[] };
  }

  private async uploadMedia(buffer: Buffer, fileName: string, mimeType: string): Promise<string> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), fileName);
    const res = await fetch(`${this.baseUrl}/${this.phoneNumberId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body: form,
    });
    const body = (await res.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null;
    if (!res.ok || !body?.id) throw new Error(body?.error?.message ?? `Falha ao enviar midia para a API Oficial (HTTP ${res.status})`);
    return body.id;
  }

  async sendText(chatId: string, text: string, options?: SendTextOptions): Promise<SendResult> {
    const payload: Record<string, unknown> = { messaging_product: "whatsapp", to: digitsOnly(chatId), type: "text", text: { body: text } };
    if (options?.replyToProviderMessageId) payload.context = { message_id: options.replyToProviderMessageId };
    const body = await this.graphPost(`${this.phoneNumberId}/messages`, payload);
    return { providerMessageId: body.messages?.[0]?.id ?? randomUUID(), timestamp: new Date() };
  }

  async sendFile(chatId: string, buffer: Buffer, fileName: string, mimeType: string, caption?: string): Promise<SendResult> {
    const mediaId = await this.uploadMedia(buffer, fileName, mimeType);
    const type = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("video/") ? "video" : "document";
    const mediaPayload: Record<string, unknown> = { id: mediaId };
    if (caption) mediaPayload.caption = caption;
    if (type === "document") mediaPayload.filename = fileName;
    const body = await this.graphPost(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to: digitsOnly(chatId),
      type,
      [type]: mediaPayload,
    });
    return { providerMessageId: body.messages?.[0]?.id ?? randomUUID(), timestamp: new Date() };
  }

  /**
   * A flow menu as WhatsApp's own reply buttons (up to 3 short options, the picture above them) or a list (up to 10).
   * A body longer than WhatsApp takes goes first as a plain text. A list row longer than WhatsApp shows is cut, with
   * the full name underneath.
   */
  async sendMenu(chatId: string, menu: OutboundMenu): Promise<SendResult> {
    if (menu.options.length === 0 || menu.options.length > MAX_LIST_ROWS) throw new Error(`Um menu da API Oficial tem de 1 a ${MAX_LIST_ROWS} opções`);
    let body = menu.body.trim();
    if (body.length > MAX_INTERACTIVE_BODY) {
      await this.sendText(chatId, body);
      body = LONG_BODY_FOLLOW_UP;
    }
    const asButtons = menu.options.length <= MAX_BUTTONS && menu.options.every((o) => o.label.length <= MAX_BUTTON_TITLE);
    let interactive: Record<string, unknown>;
    if (asButtons) {
      interactive = {
        type: "button",
        body: { text: body },
        action: { buttons: menu.options.map((o) => ({ type: "reply", reply: { id: o.id, title: o.label } })) },
      };
      if (menu.image) interactive.header = { type: "image", image: { id: await this.uploadMedia(menu.image.buffer, menu.image.fileName, menu.image.mimeType) } };
    } else {
      // A list has no picture of its own: it goes just before.
      if (menu.image) await this.sendFile(chatId, menu.image.buffer, menu.image.fileName, menu.image.mimeType);
      interactive = {
        type: "list",
        body: { text: body },
        action: {
          button: clip(menu.listButton ?? "Ver opções", MAX_LIST_LABEL),
          sections: [
            {
              title: clip(menu.listTitle ?? "Opções", MAX_ROW_TITLE),
              rows: menu.options.map((o) => ({
                id: o.id,
                title: clip(o.label, MAX_ROW_TITLE),
                ...(o.label.length > MAX_ROW_TITLE ? { description: clip(o.label, MAX_ROW_DESCRIPTION) } : {}),
              })),
            },
          ],
        },
      };
    }
    const result = await this.graphPost(`${this.phoneNumberId}/messages`, { messaging_product: "whatsapp", to: digitsOnly(chatId), type: "interactive", interactive });
    return { providerMessageId: result.messages?.[0]?.id ?? randomUUID(), timestamp: new Date() };
  }

  /**
   * A Meta-approved template — the only kind of message the Cloud API
   * accepts once 24h have passed since the customer's last message.
   * Parameters fill {{1}}, {{2}}... in order; a media header is uploaded
   * first and referenced by id.
   */
  async sendTemplate(chatId: string, template: TemplateSendInput): Promise<SendResult> {
    const components: Record<string, unknown>[] = [];
    if (template.headerMedia) {
      const kind = template.headerMedia.kind;
      const mediaId = await this.uploadMedia(template.headerMedia.buffer, template.headerMedia.fileName, template.headerMedia.mimeType);
      const media: Record<string, unknown> = { id: mediaId };
      if (kind === "document") media.filename = template.headerMedia.fileName;
      components.push({ type: "header", parameters: [{ type: kind, [kind]: media }] });
    } else if (template.headerParams.length > 0) {
      components.push({ type: "header", parameters: template.headerParams.map((text) => ({ type: "text", text })) });
    }
    if (template.bodyParams.length > 0) {
      components.push({ type: "body", parameters: template.bodyParams.map((text) => ({ type: "text", text })) });
    }
    const body = await this.graphPost(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to: digitsOnly(chatId),
      type: "template",
      template: { name: template.name, language: { code: template.language }, components },
    });
    return { providerMessageId: body.messages?.[0]?.id ?? randomUUID(), timestamp: new Date() };
  }

  async sendAudio(chatId: string, buffer: Buffer, mimeType: string): Promise<SendResult> {
    const mediaId = await this.uploadMedia(buffer, "audio", mimeType);
    const body = await this.graphPost(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to: digitsOnly(chatId),
      type: "audio",
      audio: { id: mediaId },
    });
    return { providerMessageId: body.messages?.[0]?.id ?? randomUUID(), timestamp: new Date() };
  }

  async sendLocation(chatId: string, latitude: number, longitude: number): Promise<SendResult> {
    const body = await this.graphPost(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to: digitsOnly(chatId),
      type: "location",
      location: { latitude, longitude },
    });
    return { providerMessageId: body.messages?.[0]?.id ?? randomUUID(), timestamp: new Date() };
  }

  // The Cloud API's "contacts" message type takes structured name/phone
  // fields, not a raw vcard string the rest of this app works with
  // (sendContact's callers only ever have a vcard) — rather than silently
  // mis-sending a vcard the API would reject, this is left unimplemented
  // until a real vcard->Cloud-API-contact mapping is built.
  async sendContact(): Promise<SendResult> {
    throw new Error("Envio de cartao de contato ainda nao e suportado para conexoes WhatsApp Oficial");
  }

  async sendReaction(chatId: string, providerMessageId: string, emoji: string | null): Promise<void> {
    await this.graphPost(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to: digitsOnly(chatId),
      type: "reaction",
      reaction: { message_id: providerMessageId, emoji: emoji ?? "" },
    });
  }

  async markRead(_chatId: string, providerMessageIds: string[]): Promise<void> {
    // The Cloud API marks read per message id, not per chat — best-effort,
    // same precedent as syncReadReceiptToDevice's own caller in
    // whatsapp.service.ts; one id failing never blocks the rest.
    for (const messageId of providerMessageIds) {
      await this.graphPost(`${this.phoneNumberId}/messages`, { messaging_product: "whatsapp", status: "read", message_id: messageId }).catch(() => undefined);
    }
  }

  // The Cloud API exposes no address-book/profile lookup at all — a
  // "contact" only ever exists here as whoever has messaged this number.
  async getContactInfo(chatId: string): Promise<ContactInfo> {
    return { phone: digitsOnly(chatId), name: null, photoUrl: null };
  }

  async getContactPhoto(): Promise<string | null> {
    return null;
  }

  // The Cloud API doesn't take part in WhatsApp groups.
  async listGroups(): Promise<GroupInfo[]> {
    return [];
  }

  async getGroupInfo(): Promise<GroupInfo | null> {
    return null;
  }

  // No bulk/bounded history-fetch endpoint exists on the Cloud API — this
  // app only ever learns about a chat's messages as they arrive live via
  // webhook, so onHistorySync below never fires for this provider.
  async fetchOlderHistory(): Promise<void> {}

  // No phone address book to read from a Cloud API connection.
  async listContacts(): Promise<ContactInfo[]> {
    return [];
  }

  async syncContacts(): Promise<{ count: number }> {
    return { count: 0 };
  }

  // No generic "is this number on WhatsApp" check on the Cloud API either
  // — the only way to know is to actually message it.
  async lookupNumber(): Promise<{ phone: string } | null> {
    return null;
  }

  onConnectionUpdate(listener: (status: WhatsAppStatusSnapshot) => void): void {
    this.emitter.on("connection", listener);
  }

  onMessage(listener: (event: InboundMessageEvent) => void | Promise<void>): void {
    this.messageListeners.push(listener);
  }

  onDelivery(listener: (event: DeliveryEvent) => void | Promise<void>): void {
    this.deliveryListeners.push(listener);
  }

  onReaction(listener: (event: ReactionEvent) => void | Promise<void>): void {
    this.reactionListeners.push(listener);
  }

  // The Cloud API doesn't tell when the customer is typing.
  async subscribeTyping(): Promise<void> {}

  onTyping(): void {}

  // The Cloud API's typing indicator needs the id of the customer's last message and has no "recording" — not used.
  async sendPresence(): Promise<void> {}

  // No linked-phone/companion-device concept on a Cloud API connection, so
  // none of these three ever fire — same no-op precedent as
  // MockWhatsAppProvider.onChatRead.
  onHistorySync(_listener: (event: HistorySyncEvent) => void): void {}
  onChatRead(_listener: (event: ChatReadEvent) => void): void {}
  onChatIdentityResolved(_listener: (event: ChatIdentityResolvedEvent) => void): void {}

  /**
   * Feeds one webhook "change" payload (value of entry[].changes[] with
   * field "messages") into this provider's own onMessage/onDelivery/
   * onReaction listeners — called by the Cloud API webhook route in
   * whatsapp.routes.ts once it has matched the payload's phone_number_id to
   * this connection's provider instance. Not part of WhatsAppProvider
   * itself (no other provider needs an inbound ingestion point like this,
   * since Baileys pushes events over its own socket instead).
   */
  async ingestWebhookChange(value: CloudApiWebhookValue): Promise<void> {
    for (const status of value.statuses ?? []) {
      const mapped = mapCloudApiStatus(status.status);
      if (!mapped) continue;
      const event: DeliveryEvent = {
        providerMessageId: status.id,
        chatId: status.recipient_id,
        status: mapped,
        timestamp: new Date(Number(status.timestamp) * 1000),
      };
      await Promise.all(this.deliveryListeners.map((listener) => listener(event)));
    }

    for (const raw of value.messages ?? []) {
      const contactName = value.contacts?.find((c) => c.wa_id === raw.from)?.profile.name ?? null;
      const event = await this.mapInboundMessage(raw, contactName);
      if (event) await Promise.all(this.messageListeners.map((listener) => listener(event)));
    }
  }

  private async mapInboundMessage(raw: CloudApiInboundMessage, contactName: string | null): Promise<InboundMessageEvent | null> {
    const base = {
      providerMessageId: raw.id,
      chatId: raw.from,
      phone: digitsOnly(raw.from),
      contactName,
      timestamp: new Date(Number(raw.timestamp) * 1000),
      fromMe: false as const,
      replyToProviderMessageId: raw.context?.id ?? null,
    };

    if (raw.type === "text" && raw.text) {
      return { ...base, type: "TEXT", body: raw.text.body };
    }
    // A tapped reply button or list row (a flow menu, see sendMenu): its title as the text, its id to tell which.
    const picked = raw.type === "interactive" ? (raw.interactive?.button_reply ?? raw.interactive?.list_reply) : undefined;
    if (picked) {
      return { ...base, type: "TEXT", body: picked.title, selectedOptionId: picked.id };
    }
    if (raw.type === "location" && raw.location) {
      return { ...base, type: "LOCATION", body: null, latitude: raw.location.latitude, longitude: raw.location.longitude };
    }
    const mediaField = raw.type === "image" ? raw.image : raw.type === "video" ? raw.video : raw.type === "audio" ? raw.audio : raw.type === "document" ? raw.document : null;
    if (mediaField) {
      const media = await this.fetchMediaBuffer(mediaField.id).catch(() => null);
      return {
        ...base,
        type: raw.type === "image" ? "IMAGE" : raw.type === "video" ? "VIDEO" : raw.type === "audio" ? "AUDIO" : "DOCUMENT",
        body: "caption" in mediaField ? (mediaField.caption ?? null) : null,
        mediaBuffer: media?.buffer,
        mediaMimeType: media?.mimeType ?? mediaField.mime_type,
        mediaFileName: "filename" in mediaField ? mediaField.filename : undefined,
      };
    }
    // Message types with no equivalent handled elsewhere in this app
    // (contacts, interactive replies, stickers, unsupported) are dropped
    // rather than guessed at — same "don't silently mis-map" stance as
    // sendContact above.
    return null;
  }

  private async fetchMediaBuffer(mediaId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const metaRes = await fetch(`${this.baseUrl}/${mediaId}`, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    const meta = (await metaRes.json().catch(() => null)) as { url?: string; mime_type?: string } | null;
    if (!metaRes.ok || !meta?.url) return null;
    const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    if (!fileRes.ok) return null;
    return { buffer: Buffer.from(await fileRes.arrayBuffer()), mimeType: meta.mime_type ?? "application/octet-stream" };
  }

  private setStatus(status: WhatsAppStatusSnapshot) {
    this.status = status;
    this.emitter.emit("connection", status);
  }
}

function mapCloudApiStatus(status: string): DeliveryEvent["status"] | null {
  switch (status) {
    case "sent":
      return "SENT";
    case "delivered":
      return "DELIVERED";
    case "read":
      return "READ";
    case "failed":
      return "FAILED";
    default:
      return null;
  }
}

// Minimal shape of a WhatsApp Cloud API webhook "value" object — only the
// fields this provider actually reads; Meta's real payload carries more.
export interface CloudApiWebhookValue {
  metadata?: { phone_number_id: string; display_phone_number?: string };
  contacts?: { wa_id: string; profile: { name: string } }[];
  messages?: CloudApiInboundMessage[];
  statuses?: { id: string; status: string; timestamp: string; recipient_id: string }[];
}

interface CloudApiMediaRef {
  id: string;
  mime_type: string;
  caption?: string;
  filename?: string;
}

interface CloudApiInboundMessage {
  id: string;
  from: string;
  timestamp: string;
  type: "text" | "image" | "video" | "audio" | "document" | "location" | string;
  text?: { body: string };
  location?: { latitude: number; longitude: number };
  image?: CloudApiMediaRef;
  video?: CloudApiMediaRef;
  audio?: CloudApiMediaRef;
  document?: CloudApiMediaRef;
  context?: { id: string };
  interactive?: { type: string; button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string; description?: string } };
}
