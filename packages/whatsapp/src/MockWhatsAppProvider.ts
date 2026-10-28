import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  ChatIdentityResolvedEvent,
  ConnectOptions,
  ContactInfo,
  DeliveryEvent,
  GroupInfo,
  HistorySyncEvent,
  InboundMessageEvent,
  OlderHistoryAnchor,
  PollVoteEvent,
  ReactionEvent,
  OutgoingPresence,
  TypingEvent,
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
// Fictitious group participants and messages for the simulated older history of a group (dev/tests only).
const MOCK_GROUP_PEOPLE = [
  { jid: "5565991110001@s.whatsapp.net", phone: "5565991110001", name: "Ana Paula (Recepção)", isAdmin: true },
  { jid: "5565991110002@s.whatsapp.net", phone: "5565991110002", name: "Carlos Mendes", isAdmin: false },
  { jid: "5565991110003@s.whatsapp.net", phone: "5565991110003", name: "Rita Fernandes", isAdmin: false },
];
const MOCK_GROUP_HISTORY = ["Pessoal, amanhã abrimos às 7h.", "Combinado, obrigado pelo aviso!", "Ontem a agenda fechou às 18h."];

export class MockWhatsAppProvider implements WhatsAppProvider {
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
  readonly sentTexts: { chatId: string; text: string; replyToProviderMessageId?: string; replyToText?: string | null; replyToParticipantJid?: string | null; mentions?: string[] }[] = [];
  readonly sentFiles: { chatId: string; caption?: string }[] = [];
  readonly sentAudios: { chatId: string; mimeType: string; sizeBytes: number }[] = [];
  /** Test helper: every markRead call, exactly as this "reached WhatsApp". */
  readonly readReceiptsSent: { chatId: string; providerMessageIds: string[]; participantByMessageId?: Record<string, string> }[] = [];
  /** Test/demo helper: the groups this "linked number" is in. */
  readonly mockGroups: GroupInfo[] = [];
  /** Test helper: every reaction this provider was asked to send. */
  readonly reactionsSent: { chatId: string; providerMessageId: string; emoji: string | null; targetFromMe: boolean }[] = [];

  async connect(options?: ConnectOptions): Promise<void> {
    // qrCodeDataUrl/pairingCode cleared here (not carried forward from the
    // previous status) — mirrors the real BaileysWhatsAppProvider fix:
    // switching connect mode on the same connection must not leave a stale
    // one around to shadow the newly-generated one in the UI.
    this.setStatus({ ...this.status, state: "CONNECTING", qrCodeDataUrl: null, pairingCode: null });
    await delay(400);

    if (options?.phoneNumber) {
      // WhatsApp-Web-style "link with phone number" — a short code instead of a QR scan.
      const fakeCode = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
      this.setStatus({
        ...this.status,
        state: "CODE_PENDING",
        pairingCode: `${fakeCode.slice(0, 4)}-${fakeCode.slice(4)}`,
        pairingCodeExpiresAt: new Date(Date.now() + 60_000),
        pairingPhoneNumber: options.phoneNumber.replace(/\D/g, ""),
      });
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
      connectedNumber: options?.phoneNumber ?? "5511900000000",
      lastConnectedAt: new Date(),
    });

    // Demo traffic (a customer every 45s, an old unread chat ~0.8s after connecting) only outside the automated
    // tests: landing at a random moment in the middle of one, it made counts and inserts fail now and then — a
    // different test each run. Tests that need inbound messages simulate them explicitly.
    if (process.env.NODE_ENV !== "test") {
      this.scheduleSimulatedInboundTraffic();
      this.simulatePreExistingUnreadChat();
    }
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
    this.sentTexts.push({
      chatId,
      text,
      replyToProviderMessageId: options?.replyToProviderMessageId,
      replyToText: options?.replyToText,
      ...(options?.replyToParticipantJid ? { replyToParticipantJid: options.replyToParticipantJid } : {}),
      ...(options?.mentions?.length ? { mentions: options.mentions } : {}),
    });
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

  async sendReaction(chatId: string, providerMessageId: string, emoji: string | null, options?: { targetFromMe?: boolean }): Promise<void> {
    this.ensureConnected();
    this.reactionsSent.push({ chatId, providerMessageId, emoji, targetFromMe: Boolean(options?.targetFromMe) });
  }

  async markRead(chatId: string, providerMessageIds: string[], options?: { participantByMessageId?: Record<string, string> }): Promise<void> {
    this.ensureConnected();
    this.readReceiptsSent.push({ chatId, providerMessageIds, ...(options?.participantByMessageId ? { participantByMessageId: options.participantByMessageId } : {}) });
  }

  async listGroups(): Promise<GroupInfo[]> {
    return this.mockGroups;
  }

  async getGroupInfo(chatId: string): Promise<GroupInfo | null> {
    return this.mockGroups.find((g) => g.chatId === chatId) ?? null;
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

  /** Simulates finding a couple of older messages predating whatever this app already has — see BaileysWhatsAppProvider's real implementation. */
  /** Test helper: every older-history request, exactly as it "reached WhatsApp". */
  readonly olderHistoryRequests: { chatId: string; anchor: OlderHistoryAnchor; count: number }[] = [];

  async fetchOlderHistory(chatId: string, anchor: OlderHistoryAnchor, count: number): Promise<void> {
    this.ensureConnected();
    this.olderHistoryRequests.push({ chatId, anchor, count });
    const phone = chatId.replace(/\D/g, "");
    const batchSize = Math.min(count, 3);
    // In a group, the simulated messages come from its participants (or a made-up one).
    const known = this.mockGroups.find((g) => g.chatId === chatId)?.participants ?? [];
    const people = known.length ? known : MOCK_GROUP_PEOPLE;
    const isGroup = chatId.endsWith("@g.us");
    const messages: HistorySyncEvent["messages"] = Array.from({ length: batchSize }, (_, i) => {
      const person = people[i % people.length];
      return {
        providerMessageId: `mock-hist-${randomUUID()}`,
        chatId,
        phone,
        fromMe: isGroup ? false : i % 2 === 0,
        type: "TEXT" as const,
        body: isGroup ? MOCK_GROUP_HISTORY[i % MOCK_GROUP_HISTORY.length] : `Mensagem anterior a conexao (simulada) ${batchSize - i}`,
        timestamp: new Date(anchor.timestamp.getTime() - (i + 1) * 60_000),
        ...(isGroup
          ? { group: { participantJid: person.jid, participantPhone: person.phone, participantName: person.name } }
          : {}),
      };
    });
    setTimeout(() => this.emitter.emit("historySync", { contacts: [], chats: [], messages } satisfies HistorySyncEvent), 300);
  }

  async listContacts(): Promise<ContactInfo[]> {
    if (this.status.state !== "CONNECTED") return [];
    return DEVICE_CONTACTS.map((c) => ({ phone: c.phone, name: c.name, photoUrl: null }));
  }

  async syncContacts(): Promise<{ count: number }> {
    return { count: this.status.state === "CONNECTED" ? DEVICE_CONTACTS.length : 0 };
  }

  // No real WhatsApp servers to query in dev — simulates the same
  // exists/doesn't-exist judgment call by phone-number length (a normal
  // number, DDI+DDD+subscriber, lands in the 10-13 digit range) instead of
  // always saying yes, so the "Novo número" validation flow has something
  // real to react to locally.
  async lookupNumber(phone: string): Promise<{ phone: string } | null> {
    if (this.status.state !== "CONNECTED") return null;
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 13) return null;
    return { phone: digits };
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

  onPollVote(listener: (event: PollVoteEvent) => void): void {
    this.emitter.on("pollVote", listener);
  }

  /** Tests: a poll vote arriving (already encrypted the way WhatsApp does). */
  simulatePollVote(event: PollVoteEvent): void {
    this.emitter.emit("pollVote", event);
  }

  /** Chats whose typing was asked for — tests read it. */
  typingSubscriptions: string[] = [];

  async subscribeTyping(chatId: string): Promise<void> {
    this.typingSubscriptions.push(chatId);
  }

  /** What the customer was shown of the attendant ("composing", "recording", "paused") — tests read it. */
  sentPresences: { chatId: string; presence: OutgoingPresence }[] = [];

  async sendPresence(chatId: string, presence: OutgoingPresence): Promise<void> {
    this.sentPresences.push({ chatId, presence });
  }

  onTyping(listener: (event: TypingEvent) => void): void {
    this.emitter.on("typing", listener);
  }

  /** Test helper: the customer starts/stops typing. */
  simulateTyping(event: TypingEvent): void {
    this.emitter.emit("typing", event);
  }

  onHistorySync(listener: (event: HistorySyncEvent) => void): void {
    this.emitter.on("historySync", listener);
  }

  onChatRead(): void {
    // Mock provider has no linked phone to sync a read-state from.
  }

  onChatIdentityResolved(listener: (event: ChatIdentityResolvedEvent) => void): void {
    this.emitter.on("chatIdentityResolved", listener);
  }

  /** Test helper: force a reaction event (fromMe = the echo of a reaction this app sent, or one made on the linked phone). */
  simulateReaction(event: Omit<ReactionEvent, "timestamp" | "fromPhone"> & { fromPhone?: string }): void {
    this.emitter.emit("reaction", { fromPhone: event.chatId.split("@")[0], ...event, timestamp: new Date() } satisfies ReactionEvent);
  }

  /** Test helper: force a delivery event (e.g. FAILED, which Baileys sends when WhatsApp's server rejects a message) for a message already sent. */
  simulateDelivery(event: Omit<DeliveryEvent, "timestamp">): void {
    this.emitter.emit("delivery", { ...event, timestamp: new Date() } satisfies DeliveryEvent);
  }

  /** Test helper: force a chat-identity-resolved event without a real @lid chat behind it. */
  simulateChatIdentityResolved(chatId: string, phone: string, name: string | null = null): void {
    this.emitter.emit("chatIdentityResolved", { chatId, phone, name } satisfies ChatIdentityResolvedEvent);
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

  /** Test/demo helper: someone writes in a WhatsApp group. Returns the message id. */
  simulateIncomingGroupMessage(groupChatId: string, participantPhone: string | null, participantName: string | null, body: string, extra: Partial<InboundMessageEvent> = {}): string {
    const providerMessageId = randomUUID();
    this.emitter.emit("message", {
      providerMessageId,
      chatId: groupChatId,
      phone: groupChatId.split("@")[0],
      contactName: null,
      type: "TEXT",
      body,
      replyToProviderMessageId: null,
      timestamp: new Date(),
      fromMe: false,
      group: {
        participantJid: participantPhone ? `${participantPhone}@s.whatsapp.net` : `${randomUUID().slice(0, 8)}@lid`,
        participantPhone,
        participantName,
      },
      ...extra,
    } satisfies InboundMessageEvent);
    return providerMessageId;
  }

  /** Test helper: a message typed in a group on the linked phone itself. */
  simulateDeviceSentGroupMessage(groupChatId: string, body: string): void {
    this.emitter.emit("message", {
      providerMessageId: randomUUID(),
      chatId: groupChatId,
      phone: groupChatId.split("@")[0],
      contactName: null,
      type: "TEXT",
      body,
      replyToProviderMessageId: null,
      timestamp: new Date(),
      fromMe: true,
      group: { participantJid: "", participantPhone: null, participantName: null },
    } satisfies InboundMessageEvent);
  }

  /** Test helper: a message typed on the linked phone itself (or another linked device) to this customer — an OUTBOUND message the app didn't send. */
  simulateDeviceSentMessage(phone: string, body: string): void {
    const event: InboundMessageEvent = {
      providerMessageId: randomUUID(),
      chatId: `${phone}@s.whatsapp.net`,
      phone,
      contactName: null,
      type: "TEXT",
      body,
      replyToProviderMessageId: null,
      timestamp: new Date(),
      fromMe: true,
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

  /**
   * Simulates the one-time discovery of a chat that already had unread
   * messages on the phone before this connection was ever linked here — the
   * real equivalent of a Baileys RECENT history sync revealing a chat's
   * unreadCount. See PROMPT: "conversas no WhatsApp que não foram lidas não
   * aparecem na fila". Fixed (not random) providerMessageIds so repeated
   * connects in the same dev session stay idempotent, same as the real
   * provider re-syncing on every reconnect.
   */
  private simulatePreExistingUnreadChat() {
    const contact = DEVICE_CONTACTS.find((c) => c.phone === "5511955554444")!; // Ana Ribeiro
    const chatId = `${contact.phone}@s.whatsapp.net`;
    setTimeout(() => {
      this.emitter.emit("historySync", {
        contacts: [],
        chats: [{ chatId, unreadCount: 2 }],
        messages: [
          {
            providerMessageId: "mock-preexisting-unread-1",
            chatId,
            phone: contact.phone,
            fromMe: false,
            type: "TEXT",
            body: "Oi, ainda estou esperando retorno sobre minha compra.",
            timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
          },
          {
            providerMessageId: "mock-preexisting-unread-2",
            chatId,
            phone: contact.phone,
            fromMe: false,
            type: "TEXT",
            body: "Alguem pode me ajudar?",
            timestamp: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
          },
        ],
      } satisfies HistorySyncEvent);
    }, 800);
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
