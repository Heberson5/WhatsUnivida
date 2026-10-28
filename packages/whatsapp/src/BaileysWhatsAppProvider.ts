import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import * as QRCode from "qrcode";
import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  downloadMediaMessage,
  normalizeMessageContent,
  jidNormalizedUser,
  proto,
  type AuthenticationCreds,
  type WASocket,
  type WAMessage,
  type WAMessageKey,
} from "@whiskeysockets/baileys";
import { pollInfoOf } from "./poll-vote";
import type {
  ChatIdentityResolvedEvent,
  ChatReadEvent,
  ConnectOptions,
  ContactInfo,
  DeliveryEvent,
  GroupInfo,
  HistoryChatInfo,
  HistoryMessageEvent,
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
import { deliveryEventFromBaileysUpdate } from "./delivery-status";
import { reactionEventFromBaileys } from "./reaction-event";
import { groupSenderFromBaileys, isGroupChat } from "./group-message";

export interface BaileysProviderOptions {
  /** Directory where Baileys persists the multi-device auth/session state. */
  authStateDir: string;
  /** Tests only: builds the socket instead of Baileys' makeWASocket (a fake that never reaches WhatsApp). */
  socketFactory?: (config: Parameters<typeof makeWASocket>[0]) => WASocket;
}

/**
 * Real WhatsApp integration built on Baileys (@whiskeysockets/baileys), an
 * open-source implementation of the WhatsApp Web multi-device protocol.
 *
 * Chosen over the official WhatsApp Cloud/Business API because this project
 * needs the *WhatsApp Web-style QR-code pairing* explicitly requested by the
 * product spec, with no per-conversation billing and no Meta Business
 * verification step. Trade-off (documented, not hidden): Baileys is an
 * unofficial client — WhatsApp's Terms of Service technically prohibit
 * unofficial clients, and protocol changes on WhatsApp's side can break the
 * library until it is updated upstream. For a production deployment with a
 * commercial SLA requirement, swap this class for a Cloud API-backed
 * implementation of the same WhatsAppProvider interface — no other module
 * in the codebase needs to change.
 *
 * NOTE: this class talks to WhatsApp's real servers. It cannot be exercised
 * end-to-end inside an offline/sandboxed CI run; use MockWhatsAppProvider
 * for automated tests and local demos, and this class for a real staging
 * device.
 */
/**
 * The session finished linking to the phone. `account` (the identity WhatsApp signs on pair-success) is set for QR
 * Code and pairing-code links alike; `registered` only ever turns true for a pairing-code link, so a QR Code session
 * read as unlinked by it — and every restart wiped its number and logged it out.
 */
function isLinked(creds: AuthenticationCreds): boolean {
  return Boolean(creds.account || creds.registered);
}

export class BaileysWhatsAppProvider implements WhatsAppProvider {
  private emitter = new EventEmitter();
  private socket: WASocket | null = null;
  private status: WhatsAppStatusSnapshot = {
    state: "DISCONNECTED",
    qrCodeDataUrl: null,
    pairingCode: null,
    connectedNumber: null,
    lastConnectedAt: null,
  };
  private logger = pino({ level: process.env.WHATSAPP_LOG_LEVEL ?? "silent" });
  // Populated from Baileys' contacts.upsert/contacts.update events as they
  // arrive (no makeInMemoryStore dependency needed for just this). Backs
  // listContacts() — the phone's address book, used by "start a new conversation".
  private contacts = new Map<string, ContactInfo>();
  // Every @lid <-> phone pairing WhatsApp has revealed so far (chat updates, address book, the
  // customer's own messages). A message sent from the linked phone on an @lid chat often arrives
  // with no phone attached at all — this is what still files it under the right customer.
  private lidToPhone = new Map<string, string>();
  /** Group names and participants, read from WhatsApp at most every GROUP_INFO_TTL_MS per group. */
  private groupInfoCache = new Map<string, { info: GroupInfo; at: number }>();
  private static readonly GROUP_INFO_TTL_MS = 10 * 60_000;
  // Persists the in-memory contacts Map to a small JSON file next to the
  // Baileys auth state so "Nova conversa"'s address book survives an API
  // process restart (every deploy). Without this, listContacts() came back
  // empty right after every restart — the phone's address book only
  // trickles back in gradually via contacts.upsert/update as live
  // conversations happen (see the syncFullHistory comment in connect()) —
  // which used to look like "Nova Conversa parou de trazer os contatos".
  private contactsCachePath: string;
  private lastConnectOptions: ConnectOptions | undefined;
  // Reconnect bookkeeping — see the "connection: close" handler below for
  // why this exists: without it, a socket that can never actually reach
  // WhatsApp (e.g. outbound network blocked on the host) reconnects in a
  // tight loop forever, and a truly synchronous startup failure left the
  // status stuck at CONNECTING with no way out (not even deletable — see
  // whatsapp.service.ts deleteConnection).
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Swaps the pairing code on screen for a new one when it expires — straight from one code to the next, as
  // WhatsApp Web does, never through an empty "Gerando..." in between.
  private pairingRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  // Why WhatsApp closed the socket during a pairing attempt, always logged (the main logger is silent by
  // default): the one thing needed to tell a normal restart from WhatsApp refusing the attempt.
  private pairingLogger = pino({ level: process.env.WHATSAPP_PAIRING_LOG_LEVEL ?? "info" });
  // Set only by endForShutdown() — makes the "connection: close" handler
  // below a no-op instead of running its normal status/reconnect logic,
  // since the process is exiting right after and must not persist a
  // DISCONNECTED status for a session that's still perfectly good.
  private shuttingDown = false;
  private static readonly MAX_INITIAL_PAIRING_RETRIES = 3;
  private static readonly BASE_RECONNECT_DELAY_MS = 3000;
  private static readonly MAX_RECONNECT_DELAY_MS = 30_000;
  // When the code on screen was requested — its 60 s of validity count from here.
  private pairingCodeIssuedAt: number | null = null;
  // How long one pairing code stays valid before this provider requests a
  // fresh one — matches WhatsApp Web's own "Link with phone number" code
  // lifetime (it shows a countdown and swaps to a new code once it lapses).
  private static readonly PAIRING_CODE_TTL_MS = 60_000;
  // A "Conectar com número" attempt keeps handing out new codes (one a minute, as WhatsApp Web does) for this
  // long, then stops on "Gerar novo código": every code makes WhatsApp notify the phone, and asking without end
  // gets the number throttled.
  private static readonly PAIRING_ATTEMPT_MAX_MS = 5 * 60_000;
  private pairingDeadline: number | null = null;

  // Every message this connection sent, keyed by its provider message id — backs getMessage() below.
  // WhatsApp's multi-device protocol has a recipient device ask for a decryption retry whenever it
  // can't decrypt a message (its first message from this session, or after any key desync), and
  // Baileys can only honor it (re-encrypt and resend) if it can look the original content back up;
  // when it can't, the customer is left on "Aguardando mensagem" for that message for good. The
  // retry can come long after the send — after a deploy, a restart, a busy day — so this is kept on
  // disk (sent-messages.json in the session folder) for SENT_MESSAGE_RETENTION_MS, not only the last
  // few hundred in memory as before. Only the message itself is kept (media is a link with its key,
  // not the file), so it stays small.
  private sentMessages = new Map<string, { at: number; message: string }>();
  private sentMessagesPath: string;
  private sentMessagesPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SENT_MESSAGE_RETENTION_MS = 14 * 24 * 60 * 60_000;
  private static readonly SENT_MESSAGE_MAX = 20_000;
  // Baileys' own count of retries per message — without it, a retry can fail silently or loop, and
  // the customer's session key is never renewed (its docs ask for one "to avoid a message decryption loop").
  private msgRetryCounterCache = new TtlCache(60 * 60_000);
  // Decryption retries asked by customers' phones, always logged (the main logger is silent by
  // default): which message, and whether it could be resent — what tells if "Aguardando mensagem" is fixed.
  private deliveryLogger = pino({ level: process.env.WHATSAPP_DELIVERY_LOG_LEVEL ?? "info" });

  private cacheSentMessage(sent: WAMessage | undefined): void {
    const id = sent?.key.id;
    if (!id || !sent.message) return;
    const encoded = Buffer.from(proto.Message.encode(sent.message).finish()).toString("base64");
    this.sentMessages.set(id, { at: Date.now(), message: encoded });
    this.scheduleSentMessagesPersist();
  }

  /** The content of a message this connection sent, for a recipient's decryption retry. */
  private lookupSentMessage(id: string | null | undefined): proto.IMessage | undefined {
    if (!id) return undefined;
    const entry = this.sentMessages.get(id);
    this.deliveryLogger.info({ providerMessageId: id, resent: Boolean(entry) }, entry ? "a customer's phone asked to resend a message — resending" : "a customer's phone asked to resend a message this connection no longer has");
    if (!entry) return undefined;
    try {
      return proto.Message.decode(Buffer.from(entry.message, "base64"));
    } catch {
      return undefined;
    }
  }

  private loadSentMessages() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.sentMessagesPath, "utf-8")) as { id: string; at: number; message: string }[];
      const cutoff = Date.now() - BaileysWhatsAppProvider.SENT_MESSAGE_RETENTION_MS;
      for (const e of raw) if (e.at >= cutoff) this.sentMessages.set(e.id, { at: e.at, message: e.message });
    } catch {
      // Nothing kept yet (or an unreadable file) — starts empty.
    }
  }

  // Written a moment after a send (a burst of sends is one write), dropping what is past retention.
  private scheduleSentMessagesPersist() {
    if (this.sentMessagesPersistTimer) return;
    this.sentMessagesPersistTimer = setTimeout(() => {
      this.sentMessagesPersistTimer = null;
      this.persistSentMessages();
    }, 2000);
    this.sentMessagesPersistTimer.unref?.();
  }

  private persistSentMessages() {
    const cutoff = Date.now() - BaileysWhatsAppProvider.SENT_MESSAGE_RETENTION_MS;
    for (const [id, e] of this.sentMessages) if (e.at < cutoff) this.sentMessages.delete(id);
    while (this.sentMessages.size > BaileysWhatsAppProvider.SENT_MESSAGE_MAX) {
      const oldest = this.sentMessages.keys().next().value;
      if (oldest === undefined) break;
      this.sentMessages.delete(oldest);
    }
    try {
      fs.mkdirSync(path.dirname(this.sentMessagesPath), { recursive: true });
      const tmp = `${this.sentMessagesPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Array.from(this.sentMessages, ([id, e]) => ({ id, ...e }))));
      fs.renameSync(tmp, this.sentMessagesPath);
    } catch (err) {
      this.logger.error({ err }, "failed to persist the sent-messages store to disk");
    }
  }

  constructor(private options: BaileysProviderOptions) {
    this.contactsCachePath = path.join(options.authStateDir, "contacts-cache.json");
    this.sentMessagesPath = path.join(options.authStateDir, "sent-messages.json");
    this.loadContactsCache();
    this.loadSentMessages();
  }

  private loadContactsCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.contactsCachePath, "utf-8")) as ContactInfo[] | { contacts: ContactInfo[] };
      // The older format (a bare array) mixed in opaque @lid ids as if they were
      // phone numbers and can't be told apart — dropped; the next sync rebuilds it cleanly.
      if (Array.isArray(raw)) return;
      for (const c of raw.contacts) this.contacts.set(c.phone, c);
    } catch {
      // No cache yet (first run for this connection) or a corrupt/unreadable
      // file — starts empty, same as before this cache existed.
    }
  }

  private persistContactsCache() {
    try {
      fs.mkdirSync(path.dirname(this.contactsCachePath), { recursive: true });
      fs.writeFileSync(this.contactsCachePath, JSON.stringify({ contacts: Array.from(this.contacts.values()) }));
    } catch (err) {
      this.logger.error({ err }, "failed to persist WhatsApp contacts cache to disk");
    }
  }

  // The address book (listContacts) only changes while a sync is running —
  // weekly, or when an admin asks (see syncContacts). Outside of that, contact
  // events still heal names/numbers on existing conversations but never
  // reshape the list agents browse in Nova conversa.
  private addressBookSyncing = false;

  /**
   * Re-downloads the phone's whole address book from WhatsApp's app-state
   * sync (the "contact" collection, from version 0) — otherwise contacts only
   * trickle in one by one as they happen to change. Resolves once the batch
   * has been applied.
   */
  async syncContacts(): Promise<{ count: number }> {
    const socket = this.requireSocket();
    this.addressBookSyncing = true;
    try {
      await socket.resyncAppState(["critical_unblock_low"], true);
      // Baileys flushes the buffered contacts.upsert events right as the resync ends.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } finally {
      this.addressBookSyncing = false;
    }
    this.persistContactsCache();
    return { count: this.contacts.size };
  }

  /** A connect someone asked for ("Conectar", "Gerar código", "Gerar novo código"): always a fresh attempt. */
  async connect(connectOptions?: ConnectOptions): Promise<void> {
    // A new code is what was asked for — never the one from an earlier attempt.
    this.pairingCodeIssuedAt = null;
    this.pairingDeadline = connectOptions?.phoneNumber ? Date.now() + BaileysWhatsAppProvider.PAIRING_ATTEMPT_MAX_MS : null;
    return this.start(connectOptions, false);
  }

  private clearPairingRefresh() {
    if (this.pairingRefreshTimer) {
      clearTimeout(this.pairingRefreshTimer);
      this.pairingRefreshTimer = null;
    }
  }

  /** Puts a pairing code on screen, valid until PAIRING_CODE_TTL_MS after it was issued, and schedules its replacement. */
  private showPairingCode(socket: WASocket, phoneNumber: string, rawCode: string) {
    const issuedAt = this.pairingCodeIssuedAt ?? Date.now();
    const expiresAt = new Date(issuedAt + BaileysWhatsAppProvider.PAIRING_CODE_TTL_MS);
    this.setStatus({
      ...this.status,
      state: "CODE_PENDING",
      qrCodeDataUrl: null,
      pairingCode: `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`,
      pairingCodeExpiresAt: expiresAt,
      pairingPhoneNumber: phoneNumber,
    });
    this.clearPairingRefresh();
    this.pairingRefreshTimer = setTimeout(() => void this.refreshPairingCode(socket, phoneNumber), Math.max(1000, expiresAt.getTime() - Date.now()));
  }

  private pairingWindowOver() {
    return this.pairingDeadline !== null && Date.now() >= this.pairingDeadline;
  }

  /** The code on screen expired: ask WhatsApp for the next one on the same socket; the old one stays until it arrives. */
  private async refreshPairingCode(socket: WASocket, phoneNumber: string) {
    this.pairingRefreshTimer = null;
    if (this.socket !== socket || this.status.state !== "CODE_PENDING") return;
    if (this.pairingWindowOver()) {
      this.pairingLogger.warn("pairing-code attempt window is over; waiting for \"Gerar novo código\"");
      (socket.ev.removeAllListeners as () => void)();
      socket.end(undefined);
      this.socket = null;
      this.settleDisconnected();
      return;
    }
    try {
      const rawCode = await socket.requestPairingCode(phoneNumber);
      this.pairingCodeIssuedAt = Date.now();
      if (this.socket === socket && this.status.state === "CODE_PENDING") this.showPairingCode(socket, phoneNumber, rawCode);
    } catch (err) {
      // The socket couldn't take the request — start over (the code on screen stays until the new one is there).
      this.pairingLogger.warn({ err }, "could not renew the WhatsApp pairing code on the open socket; reconnecting for a new one");
      this.pairingCodeIssuedAt = null;
      this.start(this.lastConnectOptions, true).catch((e) => this.logger.error({ err: e }, "WhatsApp reconnect attempt failed"));
    }
  }

  /** `isRetry`: an automatic reconnect — a pairing code already on screen stays there while it runs. */
  private async start(connectOptions: ConnectOptions | undefined, isRetry: boolean): Promise<void> {
    this.clearPairingRefresh();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      // Clicking "Reconectar" on a connection that's already CONNECTED (or
      // an auto-reconnect racing a manual one) used to fall straight into
      // makeWASocket() below, leaving the previous socket's WebSocket open
      // and its listeners still wired. That put two live Baileys sessions
      // on the same auth identity talking to WhatsApp at once, which
      // corrupts the Signal double-ratchet state the *other* linked
      // devices (the phone, WhatsApp Web/Desktop) use to decrypt messages
      // from this connection — surfacing there as a stuck "Aguardando
      // mensagem" placeholder that only "resolved" when the next reconnect
      // happened to win the race, then broke again on the one after.
      // Detach its listeners first so tearing it down can't fire our own
      // close/reconnect handling for a socket we're intentionally replacing.
      // (Baileys' typings require a specific event name per call, but the
      // runtime object is a plain EventEmitter under the hood — calling it
      // with no args really does clear every event, same as Node's own
      // EventEmitter#removeAllListeners().)
      (this.socket.ev.removeAllListeners as () => void)();
      this.socket.end(undefined);
      this.socket = null;
    }
    this.lastConnectOptions = connectOptions;
    // qrCodeDataUrl/pairingCode explicitly cleared here (not just spread
    // forward from the previous status) — they're mutually exclusive
    // artifacts of one specific connect attempt. Without this, switching
    // from "QR Code" to "Conectar com número" (or back) on the same
    // connection carried the OLD one over: the frontend checks
    // qrCodeDataUrl before pairingCode, so a stale QR value from an earlier
    // attempt kept winning and the newly-generated pairing code never
    // rendered at all, even though it had, in fact, been generated.
    //
    // Except on an automatic reconnect in the middle of a pairing-code attempt: WhatsApp itself closes the
    // socket right after handing out a code ("restart required"), and wiping the code for that reconnect is
    // what made it flash on screen and vanish. It stays until a new one replaces it, the phone links, or the
    // attempt is given up.
    const keepShownCode = isRetry && Boolean(connectOptions?.phoneNumber) && this.status.state === "CODE_PENDING" && Boolean(this.status.pairingCode);
    if (!keepShownCode) {
      this.setStatus({ ...this.status, state: "CONNECTING", qrCodeDataUrl: null, pairingCode: null, pairingCodeExpiresAt: null, pairingPhoneNumber: null });
    }

    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.options.authStateDir);
      const wasAlreadyLinked = isLinked(state.creds);
      // requestPairingCode() writes the number into creds.me (saved to disk). A session that never finished
      // linking must not carry it into a new socket: Baileys' handshake then logs in as an already-linked
      // device instead of registering a new one, WhatsApp refuses it, and the code on screen dies with it.
      if (!wasAlreadyLinked && (state.creds.me || state.creds.pairingCode)) {
        state.creds.me = undefined;
        state.creds.pairingCode = undefined;
      }

      const socket = (this.options.socketFactory ?? makeWASocket)({
        // The Signal keys behind a cache, as Baileys recommends: the keys of a customer who gets several
        // messages in a row used to be read and written straight to their files on every one, and two
        // writes crossing could leave that customer's session out of step — their phone then can't
        // decrypt ("Aguardando mensagem"). Baileys itself serializes key writes in transactions on top.
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.logger as any) },
        msgRetryCounterCache: this.msgRetryCounterCache,
        logger: this.logger as any,
        // REVERTED to false: turning this on destabilized an already-linked
        // real account (sending/receiving/contacts all broke) — the
        // `requireFullSync` flag Baileys sends the phone only applies at
        // fresh pairing, but this flag *also* gates whether every reconnect
        // processes the phone's history-sync payload (see
        // "messaging-history.set" below), and doing that against a real
        // account's full history apparently jammed the connection badly
        // enough to break basic message delivery. Restoring the known-good
        // default. Contacts still populate gradually via contacts.upsert/
        // contacts.update as real conversations happen (those aren't gated
        // by this flag) — just not as an upfront bulk address-book dump.
        // Re-enabling bulk history/contacts sync needs a much more careful,
        // chunked/rate-limited approach than a blanket flag flip; not
        // attempting that again against a live account blind.
        syncFullHistory: false,
        // Independent of syncFullHistory above (Baileys defaults this to
        // `() => !!syncFullHistory` when left unset, which would also
        // reject the two sync types below) — lets through only the two
        // history-sync payloads that are safe by construction:
        // RECENT is the same small "chat list + a handful of recent
        // messages per chat, plus unread counts" sync every normal
        // WhatsApp Web/multi-device linking already receives regardless of
        // this app — not the account-wide FULL dump that broke a live
        // account before (see syncFullHistory's own comment). It's how a
        // chat that already had unread messages before this app was ever
        // linked gets discovered at all — see PROMPT: "conversas no
        // WhatsApp que não foram lidas não aparecem na fila, pois são
        // conversas que já estavam sem ler antes de conectar o WhatsApp".
        // ON_DEMAND is the response to this app's own bounded,
        // one-chat-at-a-time fetchOlderHistory request below — without
        // this, that response would be silently dropped here before ever
        // reaching the "messaging-history.set" listener.
        shouldSyncHistoryMessage: (msg) =>
          msg.syncType === proto.Message.HistorySyncNotification.HistorySyncType.RECENT ||
          msg.syncType === proto.Message.HistorySyncNotification.HistorySyncType.ON_DEMAND,
        // Pairing-code linking and QR linking are mutually exclusive per
        // Baileys session: suppress the QR event entirely when a phone number
        // was given, since we're about to request a code instead.
        printQRInTerminal: false,
        // See sentMessages' own comment above — without this, a
        // recipient device's decryption-retry request can never be
        // fulfilled and that message is stuck on their end forever.
        getMessage: async (key) => this.lookupSentMessage(key.id),
      });
      this.socket = socket;
      let codeRequested = false;

      socket.ev.on("creds.update", saveCreds);

      socket.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr && !connectOptions?.phoneNumber) {
          this.reconnectAttempts = 0;
          const qrCodeDataUrl = await QRCode.toDataURL(qr);
          this.setStatus({ ...this.status, state: "QR_PENDING", qrCodeDataUrl });
        }

        // "Conectar com número": the first QR of this socket means WhatsApp finished the handshake and is waiting
        // for this new device to be linked — only now can the code be asked for (Baileys' own guidance). Asked
        // earlier, it rode the handshake and WhatsApp refused it: the code flashed on screen for a few seconds
        // and the phone said it couldn't link. The QR itself is not shown in this mode.
        if (qr && connectOptions?.phoneNumber && !wasAlreadyLinked && !codeRequested) {
          codeRequested = true;
          const phoneNumber = connectOptions.phoneNumber.replace(/\D/g, "");
          try {
            const rawCode = await socket.requestPairingCode(phoneNumber);
            if (this.socket !== socket) return;
            this.pairingCodeIssuedAt = Date.now();
            this.reconnectAttempts = 0;
            this.showPairingCode(socket, phoneNumber, rawCode);
          } catch (err) {
            this.pairingLogger.warn({ err }, "failed to request WhatsApp pairing code; reconnecting for a new one");
            socket.end(undefined); // the close handler below retries, within the usual budget
          }
        }

        if (connection === "open") {
          this.reconnectAttempts = 0;
          // Prefer the phone-number JID (`jid`) over the raw session id —
          // same @lid privacy migration as everywhere else in this file:
          // `id` can itself be `<lid>:<device>@lid` for an account WhatsApp
          // has moved to a LID-based identity, which used to surface as a
          // meaningless "connected number" and — worse — as a false
          // same-number mismatch on every later reconnect (see
          // whatsapp.service.ts), since it no longer matched the real
          // number recorded the first time this connection was paired.
          const ownIdentity = socket.user?.jid ?? socket.user?.id ?? null;
          const connectedNumber = ownIdentity ? ownIdentity.split(":")[0].split("@")[0] : null;
          this.clearPairingRefresh();
          this.setStatus({
            state: "CONNECTED",
            qrCodeDataUrl: null,
            pairingCode: null,
            pairingCodeExpiresAt: null,
            pairingPhoneNumber: null,
            connectedNumber,
            lastConnectedAt: new Date(),
          });
        }

        if (connection === "close") {
          if (this.shuttingDown) return; // see endForShutdown() — leave status/DB alone, this process is exiting
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          // During a "Conectar com número" attempt a close is not the end of it: WhatsApp restarts the socket
          // (515) once the phone accepts the code, and drops it when the attempt's QR refs run out or the network
          // blips. The code stays on screen while the reconnect runs — the next socket asks for a fresh one (or,
          // after the 515, logs in linked) — and only goes once the retries or the attempt window are spent.
          // QR-code connects are unaffected.
          this.clearPairingRefresh();
          const isExpectedPairingRestart =
            shouldReconnect &&
            Boolean(connectOptions?.phoneNumber) &&
            !wasAlreadyLinked &&
            this.status.state === "CODE_PENDING";

          if (connectOptions?.phoneNumber && !wasAlreadyLinked) {
            // WHATSAPP_LOG_LEVEL defaults to "silent" (see the logger
            // above), which was swallowing every diagnostic this file
            // already logs for a failed pairing attempt — this line is
            // the one that actually matters for telling apart "WhatsApp's
            // own expected restart-required close, handled" from a real
            // rejection (e.g. its own anti-abuse throttling after many
            // pairing-code requests in a short time, which surfaces as a
            // *different* statusCode here, not 515). Set
            // WHATSAPP_LOG_LEVEL=info (or lower) to see it.
            this.pairingLogger.warn(
              { statusCode, keepsCodeOnScreen: isExpectedPairingRestart, reconnectAttempts: this.reconnectAttempts },
              "WhatsApp connection closed during a pairing-code attempt"
            );
          }

          if (!isExpectedPairingRestart) {
            this.settleDisconnected();
          }

          // The phone typed the code: WhatsApp restarts the socket (515) and the next one logs in, linked. Short of
          // that, an attempt past its window stops here, on "Gerar novo código", instead of asking for more codes.
          const pairingSucceeded = !wasAlreadyLinked && isLinked(state.creds);
          if (connectOptions?.phoneNumber && !wasAlreadyLinked && !pairingSucceeded && this.pairingWindowOver()) {
            this.settleDisconnected();
            return;
          }

          if (!shouldReconnect) {
            // WhatsApp itself revoked this session (unlinked from the
            // phone's own "Aparelhos conectados", or logged out) — the
            // credentials saved on disk are now permanently dead. Without
            // clearing them, the *next* connect() attempt would keep
            // seeing a linked session and silently retry
            // this same dead session instead of falling back to a fresh
            // QR/pairing-code flow — which is exactly what used to leave
            // "Conectar" on an existing connection generating nothing at
            // all after a real logout.
            await fs.promises.rm(this.options.authStateDir, { recursive: true, force: true }).catch(() => undefined);
            return; // explicit logout — never auto-retry
          }

          this.reconnectAttempts += 1;
          // A session that was linked before and just dropped (network
          // blip, WhatsApp-side restart) is worth retrying indefinitely
          // with backoff — that's normal operation. A *fresh* pairing
          // attempt that never got past QR/code generation is much more
          // likely a real problem (e.g. no outbound network access to
          // WhatsApp's servers from this host) — retrying that forever
          // just hides the failure and leaves the admin stuck watching
          // "Conectando..." with no explanation, so give up after a few
          // tries and let the connection settle back to DISCONNECTED.
          if (!wasAlreadyLinked && this.reconnectAttempts > BaileysWhatsAppProvider.MAX_INITIAL_PAIRING_RETRIES) {
            this.logger.error(
              "giving up on WhatsApp pairing after repeated failed attempts — check that this host has outbound network access to WhatsApp's servers"
            );
            // A restart-required close skipped settleDisconnected() above
            // to keep the code on screen through what's normally a quick
            // reconnect — but retries are now exhausted, so this really is
            // a dead end and any lingering pairing code must be cleared.
            this.settleDisconnected();
            return;
          }
          const delay = Math.min(
            BaileysWhatsAppProvider.BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
            BaileysWhatsAppProvider.MAX_RECONNECT_DELAY_MS
          );
          this.reconnectTimer = setTimeout(() => {
            this.start(this.lastConnectOptions, true).catch((err) => this.logger.error({ err }, "WhatsApp reconnect attempt failed"));
          }, delay);
        }
      });

      socket.ev.on("messages.upsert", async ({ messages, type }) => {
        for (const message of messages) {
          // "append" = delivered late (sent while this connection was off or restarting): only poll votes are taken
          // from it — they would otherwise be lost, and a vote never makes a message of its own.
          if (type !== "notify" && !normalizeMessageContent(message.message)?.pollUpdateMessage) continue;
          await this.handleIncomingMessage(message);
        }
      });

      socket.ev.on("contacts.upsert", (contacts) => this.upsertContacts(contacts));
      socket.ev.on("contacts.update", (contacts) => this.upsertContacts(contacts));

      socket.ev.on("messaging-history.set", ({ contacts, messages, chats }) => {
        this.upsertContacts(contacts);
        const converted: HistoryMessageEvent[] = [];
        for (const message of messages) {
          const chatId = message.key.remoteJid ?? "";
          if (!chatId || isIgnoredChat(chatId)) continue;
          const entry = convertHistoryMessage(message, chatId, this.authorJid(message.key));
          if (!entry) continue;
          // A group's history keeps who wrote each message; the app only stores it for groups it already shows.
          const group = groupSenderFromBaileys(message.key, message.key.fromMe ? null : message.pushName);
          converted.push(group ? { ...entry, group } : entry);
        }
        const unreadChats: HistoryChatInfo[] = chats
          .filter((c) => c.id && !isNonCustomerChat(c.id) && Number(c.unreadCount ?? 0) > 0)
          .map((c) => ({ chatId: c.id, unreadCount: Number(c.unreadCount) }));
        if (converted.length > 0 || contacts.length > 0 || unreadChats.length > 0) {
          this.emitter.emit("historySync", {
            contacts: Array.from(this.contacts.values()),
            chats: unreadChats,
            messages: converted,
          } satisfies HistorySyncEvent);
        }
      });

      socket.ev.on("messages.update", (updates) => {
        for (const update of updates) {
          const event = deliveryEventFromBaileysUpdate(update);
          if (event) this.emitter.emit("delivery", event);
        }
      });

      // Fires whenever WhatsApp's multi-device sync pushes a chat-state
      // change from any linked device — most relevantly, the phone itself
      // marking a chat as read. Only the transition to "no unread messages
      // left" matters here; every other partial update (archived, pinned,
      // muted, etc.) is ignored.
      socket.ev.on("chats.update", (updates) => {
        for (const update of updates) {
          const chatId = update.id;
          if (!chatId || isNonCustomerChat(chatId)) continue;
          // Fires independently of the read-state check below — a chat's
          // pnJid can become known on its own, and this is the ONLY way a
          // contact ever self-heals when it was created from a message
          // that couldn't resolve a phone number at all to begin with
          // (see ChatIdentityResolvedEvent).
          if (chatId.endsWith("@lid") && update.pnJid) {
            this.rememberLid(chatId, update.pnJid.split("@")[0]);
            this.emitter.emit("chatIdentityResolved", {
              chatId,
              phone: update.pnJid.split("@")[0],
            } satisfies ChatIdentityResolvedEvent);
          }
          if (update.unreadCount === undefined || update.unreadCount === null) continue;
          if (Number(update.unreadCount) > 0) continue;
          this.emitter.emit("chatRead", { chatId, phone: phoneFromJid(chatId, update.pnJid) } satisfies ChatReadEvent);
        }
      });

      socket.ev.on("presence.update", ({ id, presences }) => {
        const active = (p: { lastKnownPresence?: string }) => p.lastKnownPresence === "composing" || p.lastKnownPresence === "recording";
        if (isGroupChat(id)) {
          // Each participant on their own: "Marta está digitando…", "Carlos está gravando áudio…".
          for (const [participant, p] of Object.entries(presences)) {
            const phone = participant.endsWith("@s.whatsapp.net") ? participant.split("@")[0].split(":")[0] : null;
            this.emitter.emit("typing", {
              chatId: id,
              typing: active(p),
              kind: p.lastKnownPresence === "recording" ? "recording" : "typing",
              participantJid: participant,
              participantPhone: phone,
            } satisfies TypingEvent);
          }
          return;
        }
        const list = Object.values(presences);
        const typing = list.some(active);
        const kind = list.some((p) => p.lastKnownPresence === "recording") ? "recording" : "typing";
        this.emitter.emit("typing", { chatId: id, typing, kind } satisfies TypingEvent);
      });

      socket.ev.on("messages.reaction", (reactions) => {
        // In a group the event also says which participant reacted.
        for (const r of reactions) this.emitter.emit("reaction", reactionEventFromBaileys(r));
      });
    } catch (err) {
      // A failure before the socket even got a chance to try connecting
      // (e.g. can't write to WHATSAPP_AUTH_DIR) used to leave status stuck
      // at CONNECTING forever, with no error surfaced anywhere the admin
      // could see it, and no way to even delete the connection.
      this.logger.error({ err }, "failed to start WhatsApp connection");
      this.settleDisconnected();
    }
  }

  /** Resets status to DISCONNECTED while preserving lastConnectedAt — shared by every "give up" path in connect(). */
  private settleDisconnected() {
    // Whatever pairing code was tracked as "fresh" no longer means
    // anything once the connection has actually settled back to
    // DISCONNECTED — the next connect() attempt (even one that finds an
    // old, not-yet-cleared code still sitting in authState.creds from a
    // pairing attempt that ran out of retries) must always request a
    // genuinely new one rather than treating that leftover as reusable.
    this.pairingCodeIssuedAt = null;
    this.clearPairingRefresh();
    this.setStatus({
      state: "DISCONNECTED",
      qrCodeDataUrl: null,
      pairingCode: null,
      pairingCodeExpiresAt: null,
      pairingPhoneNumber: null,
      connectedNumber: null,
      lastConnectedAt: this.status.lastConnectedAt,
    });
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.socket?.logout().catch(() => undefined);
    this.socket = null;
    this.contacts.clear();
    // An explicit disconnect means unlinking — the credentials are dead
    // either way (socket.logout() already told WhatsApp's servers to
    // revoke them when that succeeded; wiping them here too guarantees it
    // regardless, so the next "Conectar" always gets a genuinely fresh
    // QR/pairing-code flow instead of silently retrying a dead session —
    // see the same reasoning in the "connection: close" / loggedOut branch
    // of connect()). A future relink could also be a different phone
    // entirely, so the cached address book must not bleed into it either.
    fs.rmSync(this.options.authStateDir, { recursive: true, force: true });
    fs.rmSync(this.contactsCachePath, { force: true });
    this.sentMessages.clear();
    this.settleDisconnected();
  }

  async endForShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearPairingRefresh();
    if (this.sentMessagesPersistTimer) {
      clearTimeout(this.sentMessagesPersistTimer);
      this.sentMessagesPersistTimer = null;
      this.persistSentMessages();
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      // end() sends a proper WebSocket close frame (as opposed to the
      // process simply dying and the OS dropping the TCP connection) —
      // give it a brief moment to actually reach WhatsApp's servers
      // before the process exits.
      socket.end(undefined);
      setTimeout(resolve, 250);
    });
  }

  getStatus(): WhatsAppStatusSnapshot {
    return this.status;
  }

  async sendText(chatId: string, text: string, options?: SendTextOptions): Promise<SendResult> {
    const socket = this.requireSocket();
    // Baileys reads quoted.message (not just quoted.key) to build the
    // reply-preview stanza — passing a key with no message content throws
    // inside its own message-generation code, which used to fail every
    // reply send silently (caught and swallowed by sendOutboundText).
    const quoted = options?.replyToProviderMessageId
      ? {
          key: {
            id: options.replyToProviderMessageId,
            remoteJid: chatId,
            fromMe: false,
            ...(options.replyToParticipantJid ? { participant: options.replyToParticipantJid } : {}),
          },
          message: { conversation: options.replyToText ?? "" },
        }
      : undefined;
    // Baileys already generates a link-preview card on its own for every
    // text send whose body contains a URL (sendMessage wires its own
    // getUrlInfo — Open Graph title/description + a compressed thumbnail —
    // into the outgoing extendedTextMessage by default; see
    // Socket/messages-send.js), the same rich card WhatsApp Web itself
    // builds before a link leaves the composer. A fetch failure/timeout is
    // swallowed internally there; the text still sends, just without a card.
    const sent = await socket.sendMessage(chatId, { text, ...(options?.mentions?.length ? { mentions: options.mentions } : {}) }, { quoted: quoted as any });
    this.cacheSentMessage(sent);
    const sentExt = sent?.message?.extendedTextMessage;
    return {
      providerMessageId: sent?.key.id ?? "",
      timestamp: new Date(),
      linkPreview: sentExt?.title
        ? {
            title: sentExt.title,
            description: sentExt.description ?? null,
            url: sentExt.matchedText ?? "",
            thumbnailBase64: sentExt.jpegThumbnail ? Buffer.from(sentExt.jpegThumbnail).toString("base64") : null,
          }
        : null,
    };
  }

  async sendFile(
    chatId: string,
    buffer: Buffer,
    fileName: string,
    mimeType: string,
    caption?: string
  ): Promise<SendResult> {
    const socket = this.requireSocket();
    const isImage = mimeType.startsWith("image/");
    const isVideo = mimeType.startsWith("video/");
    // An audio file (as opposed to a recorded voice note — see sendAudio
    // below) still needs its own `audio` payload, not `document`: WhatsApp
    // only renders the inline playable waveform/player for a message sent
    // this way. Anything falling through to `document` shows up on the
    // recipient's phone as a plain downloadable file, never as playable
    // audio at all — see PROMPT: "está chegando no celular do cliente como
    // um arquivo web".
    const isAudio = mimeType.startsWith("audio/");
    const payload = isImage
      ? { image: buffer, caption, mimetype: mimeType }
      : isVideo
        ? { video: buffer, caption, mimetype: mimeType }
        : isAudio
          ? { audio: buffer, mimetype: mimeType, ptt: false }
          : { document: buffer, fileName, mimetype: mimeType, caption };
    const sent = await socket.sendMessage(chatId, payload as any);
    this.cacheSentMessage(sent);
    return { providerMessageId: sent?.key.id ?? "", timestamp: new Date() };
  }

  /**
   * A recorded voice note (WhatsApp's "PTT" — push-to-talk — message type):
   * the compact waveform bubble with a play button, distinct from an
   * attached audio file (see sendFile above, which sends ptt: false).
   * WhatsApp's own clients only recognize this bubble when the audio is
   * genuinely OGG/Opus-encoded — `mimeType` here must reflect what `buffer`
   * actually contains (the caller is responsible for transcoding first; see
   * apps/api's audio-transcode util), not just claim to be ogg while still
   * carrying whatever the browser's MediaRecorder produced (typically
   * WebM/Opus) — that mismatch is what used to make a recorded voice note
   * land on the customer's phone as a generic, unplayable "web file" even
   * after ptt: true was added here.
   */
  async sendAudio(chatId: string, buffer: Buffer, mimeType: string): Promise<SendResult> {
    const socket = this.requireSocket();
    const sent = await socket.sendMessage(chatId, {
      audio: buffer,
      mimetype: mimeType,
      ptt: true,
    });
    this.cacheSentMessage(sent);
    return { providerMessageId: sent?.key.id ?? "", timestamp: new Date() };
  }

  async sendLocation(chatId: string, latitude: number, longitude: number): Promise<SendResult> {
    const socket = this.requireSocket();
    const sent = await socket.sendMessage(chatId, { location: { degreesLatitude: latitude, degreesLongitude: longitude } });
    this.cacheSentMessage(sent);
    return { providerMessageId: sent?.key.id ?? "", timestamp: new Date() };
  }

  async sendContact(chatId: string, vcard: string, displayName: string): Promise<SendResult> {
    const socket = this.requireSocket();
    const sent = await socket.sendMessage(chatId, {
      contacts: { displayName, contacts: [{ vcard }] },
    });
    this.cacheSentMessage(sent);
    return { providerMessageId: sent?.key.id ?? "", timestamp: new Date() };
  }

  async sendReaction(chatId: string, providerMessageId: string, emoji: string | null, options?: { targetFromMe?: boolean }): Promise<void> {
    const socket = this.requireSocket();
    // The key names the message being reacted to, and Baileys sends it as is:
    // a message WE sent has to say fromMe, or WhatsApp looks for it among the customer's.
    const sent = await socket.sendMessage(chatId, {
      react: { text: emoji ?? "", key: { id: providerMessageId, remoteJid: chatId, fromMe: Boolean(options?.targetFromMe) } },
    });
    this.cacheSentMessage(sent);
  }

  async markRead(chatId: string, providerMessageIds: string[], options?: { participantByMessageId?: Record<string, string> }): Promise<void> {
    if (providerMessageIds.length === 0) return;
    const socket = this.requireSocket();
    // In a group each receipt also has to say who wrote the message.
    await socket.readMessages(
      providerMessageIds.map((id) => {
        const participant = options?.participantByMessageId?.[id];
        return { remoteJid: chatId, id, fromMe: false, ...(participant ? { participant } : {}) };
      })
    );
  }

  async listGroups(): Promise<GroupInfo[]> {
    const socket = this.requireSocket();
    const groups = await socket.groupFetchAllParticipating();
    const list = Object.values(groups).map((g) => groupInfoFromMetadata(g, (jid) => this.participantName(jid)));
    for (const g of list) this.groupInfoCache.set(g.chatId, { info: g, at: Date.now() });
    return list;
  }

  async getGroupInfo(chatId: string): Promise<GroupInfo | null> {
    const cached = this.groupInfoCache.get(chatId);
    if (cached && Date.now() - cached.at < BaileysWhatsAppProvider.GROUP_INFO_TTL_MS) return cached.info;
    try {
      const socket = this.requireSocket();
      const info = groupInfoFromMetadata(await socket.groupMetadata(chatId), (jid) => this.participantName(jid));
      this.groupInfoCache.set(chatId, { info, at: Date.now() });
      return info;
    } catch (err) {
      this.logger.warn({ err, chatId }, "could not read a WhatsApp group's details");
      return cached?.info ?? null;
    }
  }

  /** A group participant's name as saved in the linked phone, when known. */
  private participantName(jid: string): string | null {
    const phone = jid.split("@")[0].split(":")[0];
    return this.contacts.get(phone)?.name ?? null;
  }

  async getContactInfo(chatId: string): Promise<ContactInfo> {
    this.requireSocket();
    return {
      phone: chatId.split("@")[0],
      name: null,
      photoUrl: await this.getContactPhoto(chatId),
    };
  }

  async getContactPhoto(chatId: string): Promise<string | null> {
    const socket = this.requireSocket();
    try {
      return (await socket.profilePictureUrl(chatId, "image")) ?? null;
    } catch {
      return null;
    }
  }

  async listContacts(): Promise<ContactInfo[]> {
    return Array.from(this.contacts.values());
  }

  async lookupNumber(phone: string): Promise<{ phone: string } | null> {
    const socket = this.requireSocket();
    const results = await socket.onWhatsApp(`${phone}@s.whatsapp.net`);
    const match = results?.[0];
    if (!match || !match.exists) return null;
    return { phone: phoneFromJid(match.jid) };
  }

  /**
   * On-demand backfill for ONE chat, bounded by `count` — deliberately not
   * the same thing as syncFullHistory above. That flag makes WhatsApp push
   * the *entire* account's history across every chat during the connect
   * handshake, uncontrolled and all at once; re-enabling it once already
   * destabilized a live account (see the comment on syncFullHistory).
   * fetchMessageHistory instead asks for a specific, capped batch of
   * messages older than one this app already has, for one chat, whenever
   * the caller chooses to ask — see PROMPT: "mensagens de antes de
   * conectar o WhatsApp" (an agent opening a conversation that predates
   * this app being linked never saw anything from before that point).
   * Results (if WhatsApp has any to give) arrive later through the same
   * "messaging-history.set" listener as every other history batch, above —
   * there is nothing else to do with the resolved requestId Baileys
   * returns, so it's discarded.
   */
  async fetchOlderHistory(chatId: string, anchor: OlderHistoryAnchor, count: number): Promise<void> {
    const socket = this.requireSocket();
    await socket.fetchMessageHistory(
      count,
      { remoteJid: chatId, id: anchor.providerMessageId, fromMe: anchor.fromMe, ...(anchor.participant ? { participant: anchor.participant } : {}) },
      Math.floor(anchor.timestamp.getTime() / 1000)
    );
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

  /**
   * Who wrote a message, as poll encryption names them: this account when fromMe (its LID in a LID-addressed group),
   * else the group participant or the chat itself.
   */
  private authorJid(key: proto.IMessageKey & { addressingMode?: string | null }): string | null {
    if (key.fromMe) {
      const user = this.socket?.user as { id?: string; lid?: string } | undefined;
      const own = key.addressingMode === "lid" && user?.lid ? user.lid : user?.id;
      return own ? jidNormalizedUser(own) : null;
    }
    const author = key.participant || key.remoteJid;
    return author ? jidNormalizedUser(author) : null;
  }

  /** Every way WhatsApp may name a message's author — phone number and LID — the most likely first. */
  private authorJidCandidates(key: WAMessageKey & { addressingMode?: string | null }): string[] {
    const user = this.socket?.user as { id?: string; lid?: string } | undefined;
    const raw = key.fromMe
      ? [this.authorJid(key), user?.lid, user?.id]
      : [key.participant, key.participantPn, key.participantLid, ...(key.participant ? [] : [key.remoteJid, key.senderPn, key.senderLid])];
    return [...new Set(raw.filter((j): j is string => Boolean(j)).map((j) => jidNormalizedUser(j)))];
  }

  async subscribeTyping(chatId: string): Promise<void> {
    if (!this.socket || this.status.state !== "CONNECTED") return;
    await this.socket.presenceSubscribe(chatId);
  }

  async sendPresence(chatId: string, presence: OutgoingPresence): Promise<void> {
    if (!this.socket || this.status.state !== "CONNECTED") return;
    await this.socket.sendPresenceUpdate(presence, chatId);
  }

  onTyping(listener: (event: TypingEvent) => void): void {
    this.emitter.on("typing", listener);
  }

  onHistorySync(listener: (event: HistorySyncEvent) => void): void {
    this.emitter.on("historySync", listener);
  }

  onChatRead(listener: (event: ChatReadEvent) => void): void {
    this.emitter.on("chatRead", listener);
  }

  onChatIdentityResolved(listener: (event: ChatIdentityResolvedEvent) => void): void {
    this.emitter.on("chatIdentityResolved", listener);
  }

  private requireSocket(): WASocket {
    if (!this.socket || this.status.state !== "CONNECTED") {
      throw new Error("WhatsApp provider is not connected");
    }
    return this.socket;
  }

  private setStatus(status: WhatsAppStatusSnapshot) {
    this.status = status;
    this.emitter.emit("connection", status);
  }

  private upsertContacts(contacts: Array<{ id?: string; jid?: string; lid?: string; name?: string | null; notify?: string | null; imgUrl?: string | null }>) {
    for (const c of contacts) {
      if (!c.id || isNonCustomerChat(c.id)) continue;
      // `id` is `@lid` (an opaque privacy identifier, not a phone number)
      // for a growing share of contacts — Baileys separately hands back the
      // real phone-number JID as `jid` whenever it knows it.
      const phone = (c.jid ?? c.id).split("@")[0];
      // An @lid with no known phone number can't be started from the address
      // book and would show up as a long meaningless "number" — never listed.
      const hasRealNumber = !(c.id.endsWith("@lid") && !c.jid);
      const existing = this.contacts.get(phone);
      // `c.name` is specifically "the name you have saved on your WA" (the
      // linked phone's own address book) — distinct from `c.notify`, which
      // is whatever the customer set as their own WhatsApp display name.
      // The saved name is the one an agent actually recognizes, so it's
      // preferred here for the address-book cache too.
      const savedName = c.name ?? null;
      if (hasRealNumber && this.addressBookSyncing) {
        this.contacts.set(phone, {
          phone,
          name: savedName ?? c.notify ?? existing?.name ?? null,
          photoUrl: (c.imgUrl && c.imgUrl !== "changed" ? c.imgUrl : existing?.photoUrl) ?? null,
        });
      }
      // The address book entry itself carries the @lid <-> phone pairing
      // (contactAction.lidJid) — this is what lets a customer who only ever
      // appeared as an opaque @lid finally get their real number.
      if (hasRealNumber && c.lid && c.lid !== c.id) {
        this.rememberLid(c.lid, phone);
        this.emitter.emit("chatIdentityResolved", { chatId: c.lid, phone, name: savedName } satisfies ChatIdentityResolvedEvent);
      }
      // The phone's address-book sync (contacts.upsert/contacts.update) is a
      // second, independent source for the exact same @lid<->real-phone
      // pairing that chats.update's pnJid resolves — and one that tends to
      // arrive earlier/more reliably (it fires on every contact sync, not
      // only once a chat-state update happens to carry it). Feeding it into
      // the same chatIdentityResolved healing path closes the window where a
      // contact/conversation created from an @lid-only event (see
      // handleIncomingMessage) never gets folded into the one a later event
      // creates under the resolved phone-number id — which is what used to
      // show up as the same customer listed twice, once by phone number and
      // once by the opaque WhatsApp id.
      //
      // Also fired (with no lid involved) whenever this contact has a saved
      // name, so Atendimento/Gestão can show the name actually saved in the
      // linked phone instead of whatever pushName the customer picked for
      // themselves — see PROMPT: "sincronizar com os contatos já salvo no
      // celular". `createIfMissing: false` on the consumer side keeps this
      // from ever creating a Contact row for someone who never actually
      // messaged this connection, just because they're in the address book.
      const identityResolved = c.id.endsWith("@lid") && c.jid && phone !== c.id.split("@")[0];
      if (identityResolved) this.rememberLid(c.id, phone);
      if (identityResolved || savedName) {
        this.emitter.emit("chatIdentityResolved", { chatId: c.id, phone, name: savedName } satisfies ChatIdentityResolvedEvent);
      }
    }
    if (this.addressBookSyncing) this.persistContactsCache();
  }

  private rememberLid(lid: string, phone: string) {
    if (lid.endsWith("@lid") && phone && phone !== lid.split("@")[0]) this.lidToPhone.set(lid, phone);
  }

  /**
   * The customer's phone for a message. On a message sent from the linked phone (fromMe) the
   * sender is this account itself, so its senderPn is our own number, never the customer's —
   * there the remembered @lid pairing is the only reliable source.
   */
  private phoneForMessage(chatId: string, message: WAMessage): string {
    const ownPhone = (this.socket?.user?.id ?? "").split("@")[0].split(":")[0];
    const alt = message.key.senderPn ?? message.key.participantPn ?? null;
    const altIsOwn = Boolean(message.key.fromMe && alt && alt.split("@")[0].split(":")[0] === ownPhone);
    const usableAlt = altIsOwn ? null : alt;
    if (chatId.endsWith("@lid") && usableAlt && !message.key.fromMe) this.rememberLid(chatId, usableAlt.split("@")[0].split(":")[0]);
    const known = this.lidToPhone.get(chatId);
    return phoneFromJid(chatId, usableAlt ?? (known ? `${known}@s.whatsapp.net` : null));
  }

  private async handleIncomingMessage(message: WAMessage): Promise<void> {
    // Previously dropped every fromMe message outright to avoid the app
    // double-recording its own sends — but that also silently dropped
    // every message sent directly from the linked phone (or any other
    // linked device), since WhatsApp's protocol marks both cases fromMe
    // identically. The consumer now de-duplicates by providerMessageId
    // instead — see fromMe on InboundMessageEvent.
    const chatId = message.key.remoteJid ?? "";
    if (!chatId || isIgnoredChat(chatId)) return; // ignore status updates, broadcast lists, channels
    // A group message: the app decides whether that connection takes groups at all.
    const group = groupSenderFromBaileys(message.key, message.key.fromMe ? null : message.pushName);

    // Disappearing ("temporária"), view-once and captioned-document messages come wrapped: unwrapped here, or they never showed up.
    const content = normalizeMessageContent(message.message);
    if (!content) return;

    const quotedStory = extractQuotedStory(content);
    const base = {
      providerMessageId: message.key.id ?? "",
      chatId,
      phone: this.phoneForMessage(chatId, message),
      // pushName on a fromMe message is this account's own name, not the
      // customer's — never let it overwrite the contact's stored name.
      contactName: message.key.fromMe || group ? null : (message.pushName ?? null),
      ...(group ? { group } : {}),
      replyToProviderMessageId:
        content.extendedTextMessage?.contextInfo?.stanzaId ?? null,
      isQuotedStoryReply: quotedStory !== null,
      quotedStoryText: quotedStory?.text ?? null,
      quotedStoryThumbnailBase64: quotedStory?.thumbnailBase64 ?? null,
      timestamp: new Date((Number(message.messageTimestamp) || Date.now() / 1000) * 1000),
      fromMe: Boolean(message.key.fromMe),
    };

    if (content.conversation || content.extendedTextMessage?.text) {
      const ext = content.extendedTextMessage;
      this.emitter.emit("message", {
        ...base,
        type: "TEXT",
        body: content.conversation ?? ext?.text ?? "",
        // Populated by the SENDER's own phone (customer, or the linked
        // phone/another device sending directly) — WhatsApp generates a
        // link preview client-side before the message ever leaves the
        // device, so it always arrives pre-baked into extendedTextMessage
        // rather than something this app needs to fetch itself for an
        // inbound/device-sent message. See sendText for the outbound side.
        linkPreviewTitle: ext?.title ?? null,
        linkPreviewDescription: ext?.description ?? null,
        linkPreviewUrl: ext?.matchedText ?? null,
        linkPreviewThumbnailBase64: ext?.jpegThumbnail ? Buffer.from(ext.jpegThumbnail).toString("base64") : null,
      } satisfies InboundMessageEvent);
      return;
    }

    if (content.locationMessage) {
      this.emitter.emit("message", {
        ...base,
        type: "LOCATION",
        body: null,
        latitude: content.locationMessage.degreesLatitude ?? undefined,
        longitude: content.locationMessage.degreesLongitude ?? undefined,
      } satisfies InboundMessageEvent);
      return;
    }

    if (content.contactMessage) {
      this.emitter.emit("message", {
        ...base,
        type: "CONTACT",
        body: null,
        vcard: content.contactMessage.vcard ?? undefined,
      } satisfies InboundMessageEvent);
      return;
    }

    const poll = pollInfoOf(content, this.authorJid(message.key));
    if (poll) {
      this.emitter.emit("message", {
        ...base,
        type: "POLL",
        body: null,
        pollQuestion: poll.question,
        pollOptions: poll.options,
        pollSelectableCount: poll.selectableCount,
        pollSecret: poll.secret,
        pollCreatorJid: poll.creatorJid,
      } satisfies InboundMessageEvent);
      return;
    }

    // A vote in a poll: forwarded still encrypted — the app has the poll's key.
    const vote = content.pollUpdateMessage;
    if (vote?.pollCreationMessageKey?.id && vote.vote?.encPayload && vote.vote.encIv) {
      const voterJid = this.authorJid(message.key);
      if (!voterJid) return;
      this.emitter.emit("pollVote", {
        chatId,
        pollMessageId: vote.pollCreationMessageKey.id,
        voterJid,
        voterJidCandidates: this.authorJidCandidates(message.key),
        creatorJidCandidates: this.authorJidCandidates(vote.pollCreationMessageKey as WAMessageKey),
        voterName: message.key.fromMe ? null : (group?.participantName ?? message.pushName ?? null),
        voterPhone: group?.participantPhone ?? (message.key.fromMe ? null : base.phone),
        fromMe: Boolean(message.key.fromMe),
        encPayload: Buffer.from(vote.vote.encPayload).toString("base64"),
        encIv: Buffer.from(vote.vote.encIv).toString("base64"),
        timestamp: vote.senderTimestampMs ? new Date(Number(vote.senderTimestampMs)) : base.timestamp,
      } satisfies PollVoteEvent);
      return;
    }

    if (content.eventMessage) {
      const event = content.eventMessage;
      this.emitter.emit("message", {
        ...base,
        type: "EVENT",
        body: null,
        eventName: event.name ?? "",
        eventDescription: event.description ?? undefined,
        eventStartAt: event.startTime ? new Date(Number(event.startTime) * 1000) : undefined,
        eventJoinLink: event.joinLink ?? undefined,
        latitude: event.location?.degreesLatitude ?? undefined,
        longitude: event.location?.degreesLongitude ?? undefined,
      } satisfies InboundMessageEvent);
      return;
    }

    // A sticker (figurinha, animated or not) is a WebP image; a round video note (ptvMessage) is a video.
    const video = content.videoMessage ?? content.ptvMessage;
    const mediaType = content.imageMessage || content.stickerMessage
      ? "IMAGE"
      : video
        ? "VIDEO"
        : content.audioMessage
          ? "AUDIO"
          : content.documentMessage
            ? "DOCUMENT"
            : null;

    if (mediaType) {
      try {
        const buffer = (await downloadMediaMessage(message, "buffer", {})) as Buffer;
        const mediaMsg =
          content.imageMessage ?? content.stickerMessage ?? video ?? content.audioMessage ?? content.documentMessage;
        this.emitter.emit("message", {
          ...base,
          type: mediaType,
          body: (content.imageMessage?.caption || video?.caption) ?? null,
          mediaBuffer: buffer,
          mediaMimeType: mediaMsg?.mimetype ?? (content.stickerMessage ? "image/webp" : "application/octet-stream"),
          mediaFileName: (content.documentMessage as any)?.fileName ?? undefined,
          mediaIsGif: Boolean(content.videoMessage?.gifPlayback),
        } satisfies InboundMessageEvent);
      } catch (err) {
        this.logger.error({ err }, "failed to download inbound media");
      }
    }
  }
}

/**
 * The queue must only ever contain 1:1 conversations with real customers.
 * WhatsApp's JID suffix tells us the chat's kind: "@g.us" is a group,
 * "@broadcast" covers both Status/Stories updates (chatId === "status@broadcast")
 * and broadcast lists, and "@newsletter" is a channel — none of these are a
 * customer waiting for an agent, so they must never reach findOrCreateContact.
 */
function isNonCustomerChat(chatId: string): boolean {
  return isGroupChat(chatId) || isIgnoredChat(chatId);
}

/** Never reaches the app at all, not even as a group: Status updates, broadcast lists and channels. */
function isIgnoredChat(chatId: string): boolean {
  return chatId.endsWith("@broadcast") || chatId.endsWith("@newsletter");
}

/** Baileys group metadata as a provider GroupInfo; `savedName` looks a participant up in the phone's address book. */
function groupInfoFromMetadata(
  meta: { id: string; subject?: string | null; participants?: Array<{ id: string; jid?: string; name?: string; notify?: string; admin?: string | null }> },
  savedName: (jid: string) => string | null
): GroupInfo {
  return {
    chatId: meta.id,
    subject: meta.subject?.trim() || "Grupo",
    participants: (meta.participants ?? []).map((p) => {
      const phoneJid = [p.id, p.jid].find((jid) => jid?.endsWith("@s.whatsapp.net"));
      return {
        jid: p.id,
        phone: phoneJid ? phoneJid.split("@")[0].split(":")[0] : null,
        name: p.name ?? savedName(phoneJid ?? p.id) ?? p.notify ?? null,
        isAdmin: p.admin === "admin" || p.admin === "superadmin",
      };
    }),
  };
}

/**
 * A reply to a WhatsApp Status/Story carries contextInfo.remoteJid ===
 * "status@broadcast" — WhatsApp embeds the story's own content directly in
 * contextInfo.quotedMessage (its text, or a low-res jpegThumbnail for a
 * media story), since the story itself is never persisted anywhere and
 * can't be looked up after the fact once it expires. Checked across every
 * message type that can carry contextInfo, not just extendedTextMessage —
 * a story reply can be sent as media too, not only as typed text.
 */
function extractQuotedStory(content: proto.IMessage): { text: string | null; thumbnailBase64: string | null } | null {
  const contextInfo =
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    content.audioMessage?.contextInfo ??
    content.documentMessage?.contextInfo ??
    content.locationMessage?.contextInfo ??
    content.contactMessage?.contextInfo ??
    undefined;
  if (!contextInfo || contextInfo.remoteJid !== "status@broadcast") return null;

  const quoted = contextInfo.quotedMessage;
  const text = quoted?.conversation ?? quoted?.extendedTextMessage?.text ?? quoted?.imageMessage?.caption ?? quoted?.videoMessage?.caption ?? null;
  const thumbnail = quoted?.imageMessage?.jpegThumbnail ?? quoted?.videoMessage?.jpegThumbnail ?? null;
  return { text, thumbnailBase64: thumbnail ? Buffer.from(thumbnail).toString("base64") : null };
}

/**
 * WhatsApp is migrating chats to opaque `@lid` identifiers instead of the
 * phone-number-based `@s.whatsapp.net` JID, for privacy. `jid.split("@")[0]`
 * on a `@lid` JID is a meaningless internal number — not a phone number an
 * agent could recognize, call, or save — which used to show up as "the
 * wrong number" for the contact everywhere in the app. WhatsApp separately
 * hands back the real phone number wherever it's known (a message's
 * senderPn/participantPn, a chat's pnJid, a contact's jid); this picks
 * that up when available, falling back to the LID digits only when
 * WhatsApp hasn't told us the real number for this chat yet.
 */
function phoneFromJid(jid: string, altPnJid?: string | null): string {
  if (!jid.endsWith("@lid") || !altPnJid) return jid.split("@")[0];
  return altPnJid.split("@")[0];
}

/**
 * Converts one WAMessage out of a `messaging-history.set` batch into our
 * HistoryMessageEvent shape. Deliberately does NOT download media: a real
 * business account's history sync can hand back thousands of messages in
 * one batch, and re-downloading every past image/video/audio/document would
 * be slow, rate-limit-risky, and balloon disk usage for content the agent
 * may never need. Media messages are still imported (so the conversation
 * thread and its timeline are complete) but without the attachment binary —
 * MessageBubble shows a "media from before this system tracked it" state
 * for those. Only TEXT/LOCATION/CONTACT (cheap, no binary) carry full content.
 */
function convertHistoryMessage(message: WAMessage, chatId: string, authorJid: string | null): HistoryMessageEvent | null {
  const content = normalizeMessageContent(message.message);
  if (!content) return null;

  const base = {
    providerMessageId: message.key.id ?? "",
    chatId,
    phone: phoneFromJid(chatId, message.key.senderPn ?? message.key.participantPn),
    fromMe: Boolean(message.key.fromMe),
    timestamp: new Date((Number(message.messageTimestamp) || Date.now() / 1000) * 1000),
  };
  if (!base.providerMessageId) return null;

  if (content.conversation || content.extendedTextMessage?.text) {
    return { ...base, type: "TEXT", body: content.conversation ?? content.extendedTextMessage?.text ?? "" };
  }
  if (content.locationMessage) {
    return {
      ...base,
      type: "LOCATION",
      body: null,
      latitude: content.locationMessage.degreesLatitude ?? undefined,
      longitude: content.locationMessage.degreesLongitude ?? undefined,
    };
  }
  if (content.contactMessage) {
    return { ...base, type: "CONTACT", body: null, vcard: content.contactMessage.vcard ?? undefined };
  }
  const poll = pollInfoOf(content, authorJid);
  if (poll) {
    // From history (the connection starting or reconnecting, a group loaded): its key comes too, so the votes that
    // arrive afterwards can be read.
    return {
      ...base,
      type: "POLL",
      body: null,
      pollQuestion: poll.question,
      pollOptions: poll.options,
      pollSelectableCount: poll.selectableCount,
      pollSecret: poll.secret,
      pollCreatorJid: poll.creatorJid,
    };
  }
  if (content.eventMessage) {
    const event = content.eventMessage;
    return {
      ...base,
      type: "EVENT",
      body: null,
      eventName: event.name ?? "",
      eventDescription: event.description ?? undefined,
      eventStartAt: event.startTime ? new Date(Number(event.startTime) * 1000) : undefined,
      eventJoinLink: event.joinLink ?? undefined,
      latitude: event.location?.degreesLatitude ?? undefined,
      longitude: event.location?.degreesLongitude ?? undefined,
    };
  }
  if (content.imageMessage) return { ...base, type: "IMAGE", body: content.imageMessage.caption ?? null };
  if (content.stickerMessage) return { ...base, type: "IMAGE", body: null };
  if (content.videoMessage) return { ...base, type: "VIDEO", body: content.videoMessage.caption ?? null };
  if (content.ptvMessage) return { ...base, type: "VIDEO", body: null };
  if (content.audioMessage) return { ...base, type: "AUDIO", body: null };
  if (content.documentMessage) return { ...base, type: "DOCUMENT", body: content.documentMessage.title ?? null };
  return null;
}

/** A small in-memory cache with expiry — the shape Baileys asks for in msgRetryCounterCache. */
class TtlCache {
  private entries = new Map<string, { value: unknown; until: number }>();
  constructor(private ttlMs: number) {}
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.until < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }
  set<T>(key: string, value: T): void {
    if (this.entries.size > 10_000) {
      const now = Date.now();
      for (const [k, e] of this.entries) if (e.until < now) this.entries.delete(k);
    }
    this.entries.set(key, { value, until: Date.now() + this.ttlMs });
  }
  del(key: string): void {
    this.entries.delete(key);
  }
  flushAll(): void {
    this.entries.clear();
  }
}
