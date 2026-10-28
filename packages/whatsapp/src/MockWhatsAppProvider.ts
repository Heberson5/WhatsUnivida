import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  ChatIdentityResolvedEvent,
  ConnectOptions,
  ContactInfo,
  DeliveryEvent,
  InboundMessageEvent,
  ReactionEvent,
  SendResult,
  SendTextOptions,
  WhatsAppProvider,
  WhatsAppStatusSnapshot,
} from "./types";

interface MockContactSeed {
  phone: string;
  name: string | null;
}

const DEFAULT_SEED_CONTACTS: MockContactSeed[] = [
  { phone: "5511988887777", name: "Maria Silva" },
  { phone: "5511977776666", name: "Carlos Souza" },
  { phone: "5511966665555", name: null },
];

// The phone's full address book — a superset of DEFAULT_SEED_CONTACTS (which
// only seeds inbound chatter). "Start a new conversation" picks from this list.
const DEVICE_CONTACTS: MockContactSeed[] = [
  ...DEFAULT_SEED_CONTACTS,
  { phone: "5511955554444", name: "Ana Ribeiro" },
  { phone: "5511944443333", name: "Bruno Alves" },
  { phone: "5511933332222", name: "Fernanda Costa" },
  { phone: "5511922221111", name: "Rafael Lima" },
];

/**
 * Fully functional simulator used in development/demo/test environments
 * (WHATSAPP_PROVIDER=mock). It behaves like a real provider from the rest
 * of the application's point of view: it emits connection/message/delivery
 * events asynchronously and keeps in-memory state. It is intentionally
 * isolated from BaileysWhatsAppProvider so the two never share code paths.
 */
export interface MockProviderOptions {
  /** Numero que a conexao simulada reporta ao conectar (padrao: 5511900000000). */
  connectedNumber?: string;
  /** Quando false, nao gera mensagens recebidas automaticas — usado nos dados de demonstracao. Padrao: true. */
  simulateInboundTraffic?: boolean;
  /** Atraso (ms) da conexao simulada; 0 conecta quase instantaneamente. Padrao: valores originais. */
  fastConnect?: boolean;
}

export class MockWhatsAppProvider implements WhatsAppProvider {
  constructor(private readonly options: MockProviderOptions = {}) {}

  private emitter = new EventEmitter();
  private status: WhatsAppStatusSnapshot = {
    state: "DISCONNECTED",
    qrCodeDataUrl: null,
    pairingCode: null,
    connectedNumber: null,
    lastConnectedAt: null,
  };
  private autoMessageTimer: NodeJS.Timeout | null = null;
  /** Test helper: every sendText/sendFile call, exactly as this "reached WhatsApp" — lets tests assert on things like whatsapp.service.ts's sender-name prefix without a real WhatsApp account. */
  readonly sentTexts: { chatId: string; text: string; replyToProviderMessageId?: string; replyToText?: string | null }[] = [];
  readonly sentFiles: { chatId: string; caption?: string }[] = [];
  readonly sentAudios: { chatId: string; mimeType: string; sizeBytes: number }[] = [];
  /** Test helper: every markRead call, exactly as this "reached WhatsApp". */
  readonly readReceiptsSent: { chatId: string; providerMessageIds: string[] }[] = [];

  async connect(options?: ConnectOptions): Promise<void> {
    // qrCodeDataUrl/pairingCode cleared here (not carried forward from the
    // previous status) — mirrors the real BaileysWhatsAppProvider fix:
    // switching connect mode on the same connection must not leave a stale
    // one around to shadow the newly-generated one in the UI.
    this.setStatus({ ...this.status, state: "CONNECTING", qrCodeDataUrl: null, pairingCode: null });
    if (this.options.fastConnect) {
      this.setStatus({
        state: "CONNECTED",
        qrCodeDataUrl: null,
        pairingCode: null,
        connectedNumber: options?.phoneNumber ?? this.options.connectedNumber ?? "5511900000000",
        lastConnectedAt: new Date(),
      });
      if (this.options.simulateInboundTraffic !== false) this.scheduleSimulatedInboundTraffic();
      return;
    }
    await delay(400);

    if (options?.phoneNumber) {
      // WhatsApp-Web-style "link with phone number" — a short code instead of a QR scan.
      const fakeCode = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
      this.setStatus({ ...this.status, state: "CODE_PENDING", pairingCode: `${fakeCode.slice(0, 4)}-${fakeCode.slice(4)}` });
    } else {
      const fakeQr = `MOCK-QR-${randomUUID()}`;
      this.setStatus({ ...this.status, state: "QR_PENDING", qrCodeDataUrl: fakeQr });
    }

    // Simulate the operator scanning the QR / typing the code after a short delay.
    await delay(1500);
    this.setStatus({
      state: "CONNECTED",
      qrCodeDataUrl: null,
      pairingCode: null,
      connectedNumber: options?.phoneNumber ?? this.options.connectedNumber ?? "5511900000000",
      lastConnectedAt: new Date(),
    });

    if (this.options.simulateInboundTraffic !== false) this.scheduleSimulatedInboundTraffic();
  }

  async disconnect(): Promise<void> {
    if (this.autoMessageTimer) clearInterval(this.autoMessageTimer);
    this.setStatus({
      state: "DISCONNECTED",
      qrCodeDataUrl: null,
      pairingCode: null,
      connectedNumber: null,
      lastConnectedAt: this.status.lastConnectedAt,
    });
  }

  async endForShutdown(): Promise<void> {
    if (this.autoMessageTimer) clearInterval(this.autoMessageTimer);
  }

  getStatus(): WhatsAppStatusSnapshot {
    return this.status;
  }

  async sendText(chatId: string, text: string, options?: SendTextOptions): Promise<SendResult> {
    this.ensureConnected();
    this.sentTexts.push({ chatId, text, replyToProviderMessageId: options?.replyToProviderMessageId, replyToText: options?.replyToText });
    const result = { providerMessageId: randomUUID(), timestamp: new Date() };
    this.simulateDeliveryLifecycle(chatId, result.providerMessageId);
    return result;
  }

  async sendFile(chatId: string, _buffer: Buffer, _fileName: string, _mimeType: string, caption?: string): Promise<SendResult> {
    this.ensureConnected();
    this.sentFiles.push({ chatId, caption });
    const result = { providerMessageId: randomUUID(), timestamp: new Date() };
    return result;
  }

  async sendAudio(chatId: string, buffer: Buffer, mimeType: string): Promise<SendResult> {
    this.ensureConnected();
    this.sentAudios.push({ chatId, mimeType, sizeBytes: buffer.length });
    return { providerMessageId: randomUUID(), timestamp: new Date() };
  }

  async sendLocation(): Promise<SendResult> {
    this.ensureConnected();
    return { providerMessageId: randomUUID(), timestamp: new Date() };
  }

  async sendContact(): Promise<SendResult> {
    this.ensureConnected();
    return { providerMessageId: randomUUID(), timestamp: new Date() };
  }

  async sendReaction(): Promise<void> {
    this.ensureConnected();
  }

  async markRead(chatId: string, providerMessageIds: string[]): Promise<void> {
    this.ensureConnected();
    this.readReceiptsSent.push({ chatId, providerMessageIds });
  }

  async getContactInfo(chatId: string): Promise<ContactInfo> {
    const seed = DEFAULT_SEED_CONTACTS.find((c) => chatId.includes(c.phone));
    return {
      phone: seed?.phone ?? chatId.replace(/\D/g, ""),
      name: seed?.name ?? null,
      photoUrl: null,
    };
  }

  async getContactPhoto(): Promise<string | null> {
    return null;
  }

  async listContacts(): Promise<ContactInfo[]> {
    if (this.status.state !== "CONNECTED") return [];
    return DEVICE_CONTACTS.map((c) => ({ phone: c.phone, name: c.name, photoUrl: null }));
  }

  onConnectionUpdate(listener: (status: WhatsAppStatusSnapshot) => void): void {
    this.emitter.on("connection", listener);
  }

  onMessage(listener: (event: InboundMessageEvent) => void): void {
    this.emitter.on("message", listener);
  }

  onDelivery(listener: (event: DeliveryEvent) => void): void {
    this.emitter.on("delivery", listener);
  }

  onReaction(listener: (event: ReactionEvent) => void): void {
    this.emitter.on("reaction", listener);
  }

  onHistorySync(): void {
    // Mock provider has no historical backlog to sync.
  }

  onChatRead(): void {
    // Mock provider has no linked phone to sync a read-state from.
  }

  onChatIdentityResolved(listener: (event: ChatIdentityResolvedEvent) => void): void {
    this.emitter.on("chatIdentityResolved", listener);
  }

  /** Test helper: force a chat-identity-resolved event without a real @lid chat behind it. */
  simulateChatIdentityResolved(chatId: string, phone: string): void {
    this.emitter.emit("chatIdentityResolved", { chatId, phone } satisfies ChatIdentityResolvedEvent);
  }

  /** Test/demo helper: force an inbound message without waiting for the timer. */
  simulateIncomingMessage(phone: string, body: string, contactName: string | null = null): void {
    const event: InboundMessageEvent = {
      providerMessageId: randomUUID(),
      chatId: `${phone}@s.whatsapp.net`,
      phone,
      contactName,
      type: "TEXT",
      body,
      replyToProviderMessageId: null,
      timestamp: new Date(),
      fromMe: false,
    };
    this.emitter.emit("message", event);
  }

  private ensureConnected() {
    if (this.status.state !== "CONNECTED") {
      throw new Error("WhatsApp provider is not connected");
    }
  }

  private setStatus(status: WhatsAppStatusSnapshot) {
    this.status = status;
    this.emitter.emit("connection", status);
  }

  private simulateDeliveryLifecycle(chatId: string, providerMessageId: string) {
    setTimeout(
      () => this.emitter.emit("delivery", { providerMessageId, chatId, status: "SENT", timestamp: new Date() } satisfies DeliveryEvent),
      200
    );
    setTimeout(
      () =>
        this.emitter.emit("delivery", {
          providerMessageId,
          chatId,
          status: "DELIVERED",
          timestamp: new Date(),
        } satisfies DeliveryEvent),
      700
    );
  }

  private scheduleSimulatedInboundTraffic() {
    let seedIndex = 0;
    this.autoMessageTimer = setInterval(() => {
      if (this.status.state !== "CONNECTED") return;
      const seed = DEFAULT_SEED_CONTACTS[seedIndex % DEFAULT_SEED_CONTACTS.length];
      seedIndex += 1;
      this.simulateIncomingMessage(
        seed.phone,
        "Ola, preciso de ajuda com meu pedido.",
        seed.name
      );
    }, 45_000);
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
