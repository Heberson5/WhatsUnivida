import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import * as QRCode from "qrcode";
import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  type WASocket,
  type WAMessage,
  type proto,
} from "@whiskeysockets/baileys";
import type {
  ChatIdentityResolvedEvent,
  ChatReadEvent,
  ConnectOptions,
  ContactInfo,
  DeliveryEvent,
  HistoryMessageEvent,
  HistorySyncEvent,
  InboundMessageEvent,
  ReactionEvent,
  SendResult,
  SendTextOptions,
  WhatsAppProvider,
  WhatsAppStatusSnapshot,
} from "./types";

export interface BaileysProviderOptions {
  /** Directory where Baileys persists the multi-device auth/session state. */
  authStateDir: string;
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
  // Set only by endForShutdown() — makes the "connection: close" handler
  // below a no-op instead of running its normal status/reconnect logic,
  // since the process is exiting right after and must not persist a
  // DISCONNECTED status for a session that's still perfectly good.
  private shuttingDown = false;
  private static readonly MAX_INITIAL_PAIRING_RETRIES = 3;
  private static readonly BASE_RECONNECT_DELAY_MS = 3000;
  private static readonly MAX_RECONNECT_DELAY_MS = 30_000;
  // When the very same pairing code was just requested, tracks when — so a
  // "restart required" reconnect moments later (see connection.update
  // "close" below) can reuse that still-fresh code instead of requesting a
  // brand new one. Baileys persists authState.creds.pairingCode to disk
  // across reconnects, but never a timestamp for it, so that has to be
  // tracked here instead; reset to null whenever a genuinely new code is
  // requested. In-memory only (not persisted) is intentional — a process
  // restart should always start a fresh pairing attempt with a fresh code.
  private pairingCodeIssuedAt: number | null = null;
  // How long one pairing code stays valid before this provider requests a
  // fresh one — matches WhatsApp Web's own "Link with phone number" code
  // lifetime (it shows a countdown and swaps to a new code once it lapses).
  private static readonly PAIRING_CODE_TTL_MS = 60_000;

  constructor(private options: BaileysProviderOptions) {
    this.contactsCachePath = path.join(options.authStateDir, "contacts-cache.json");
    this.loadContactsCache();
  }

  private loadContactsCache() {
    try {
      const raw = fs.readFileSync(this.contactsCachePath, "utf-8");
      const entries = JSON.parse(raw) as ContactInfo[];
      for (const c of entries) this.contacts.set(c.phone, c);
    } catch {
      // No cache yet (first run for this connection) or a corrupt/unreadable
      // file — starts empty, same as before this cache existed.
    }
  }

  private persistContactsCache() {
    try {
      fs.mkdirSync(path.dirname(this.contactsCachePath), { recursive: true });
      fs.writeFileSync(this.contactsCachePath, JSON.stringify(Array.from(this.contacts.values())));
    } catch (err) {
      this.logger.error({ err }, "failed to persist WhatsApp contacts cache to disk");
    }
  }

  async connect(connectOptions?: ConnectOptions): Promise<void> {
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
    this.setStatus({ ...this.status, state: "CONNECTING", qrCodeDataUrl: null, pairingCode: null });

    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.options.authStateDir);
      const wasAlreadyLinked = Boolean(state.creds.registered);

      const socket = makeWASocket({
        auth: state,
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
        // Pairing-code linking and QR linking are mutually exclusive per
        // Baileys session: suppress the QR event entirely when a phone number
        // was given, since we're about to request a code instead.
        printQRInTerminal: false,
      });
      this.socket = socket;

      socket.ev.on("creds.update", saveCreds);

      if (connectOptions?.phoneNumber && !state.creds.registered) {
        try {
          const cachedCode = state.creds.pairingCode;
          const codeStillFresh =
            Boolean(cachedCode) &&
            this.pairingCodeIssuedAt !== null &&
            Date.now() - this.pairingCodeIssuedAt < BaileysWhatsAppProvider.PAIRING_CODE_TTL_MS;

          let rawCode: string;
          if (codeStillFresh) {
            // A "restart required" reconnect (see connection.update
            // "close" below) landed here well within the current code's
            // lifetime — WhatsApp itself decided the socket needed to
            // restart, not this app, and the code the admin is looking at
            // right now is still valid (the phone is still showing it).
            // Reuse it instead of requesting a brand new one. Requesting
            // again on every single one of these reconnects — which,
            // left unchecked, happen roughly every BASE_RECONNECT_DELAY_MS
            // — was the actual cause of the code changing every ~3s and
            // never staying on screen long enough to type into WhatsApp.
            rawCode = cachedCode!;
          } else {
            // requestPairingCode() sends its request straight over the raw
            // WebSocket with no internal wait — it throws "Connection Closed"
            // immediately if that socket hasn't finished opening yet (the
            // TCP/TLS handshake to WhatsApp's servers takes real time, and
            // makeWASocket() returns long before it completes). Calling it
            // right after makeWASocket(), with nothing awaited in between,
            // hit that every time: the request failed before it ever reached
            // WhatsApp, was swallowed by the catch below, and the connection
            // just silently settled back to DISCONNECTED — no code was ever
            // generated to show. waitForSocketOpen() is Baileys' own exposed
            // helper for this exact ordering requirement.
            await socket.waitForSocketOpen();
            rawCode = await socket.requestPairingCode(connectOptions.phoneNumber.replace(/\D/g, ""));
            this.pairingCodeIssuedAt = Date.now();
          }
          // Formatted to match WhatsApp's own on-phone display convention
          // (and this project's MockWhatsAppProvider) — Baileys itself
          // returns the 8 characters with no separator.
          const code = `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`;
          // Mirrors the QR flow's own "qr" handler below, which resets this
          // on every successful QR render — reaching CODE_PENDING here is
          // real, successful progress and must clear whatever retry count
          // built up getting here. Without this, reconnectAttempts kept
          // accumulating across the "restart required" reconnects that are
          // a normal, expected part of *every* pairing-code attempt (see
          // the close handler below) — so a session that had already run
          // a few of these cycles today started the *next* attempt with
          // the retry budget already exhausted, gave up on its very first
          // restart-required close, and the freshly generated code never
          // even reached the UI before being wiped again: "Gerando..." was
          // all that ever showed.
          this.reconnectAttempts = 0;
          this.setStatus({ ...this.status, state: "CODE_PENDING", pairingCode: code });
        } catch (err) {
          this.logger.error({ err }, "failed to request WhatsApp pairing code");
          // A transient hiccup here (the raw WebSocket never finished
          // opening in time, a momentary network blip, WhatsApp briefly
          // rejecting the request) used to give up immediately with no
          // retry at all — unlike every other disconnect, which retries
          // with backoff via the "close" handler below. That asymmetry
          // meant any single bad moment during pairing silently killed
          // the whole attempt, with no code ever shown to the admin, no
          // matter how many times connect() itself was called. Retry it
          // the same bounded, backed-off way instead of giving up on the
          // first failure.
          this.reconnectAttempts += 1;
          if (!wasAlreadyLinked && this.reconnectAttempts > BaileysWhatsAppProvider.MAX_INITIAL_PAIRING_RETRIES) {
            this.logger.error(
              "giving up on WhatsApp pairing after repeated failed attempts — check that this host has outbound network access to WhatsApp's servers"
            );
            this.settleDisconnected();
            return;
          }
          const delay = Math.min(
            BaileysWhatsAppProvider.BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
            BaileysWhatsAppProvider.MAX_RECONNECT_DELAY_MS
          );
          this.reconnectTimer = setTimeout(() => {
            this.connect(connectOptions).catch((retryErr) => this.logger.error({ err: retryErr }, "WhatsApp reconnect attempt failed"));
          }, delay);
          return;
        }
      }

      socket.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr && !connectOptions?.phoneNumber) {
          this.reconnectAttempts = 0;
          const qrCodeDataUrl = await QRCode.toDataURL(qr);
          this.setStatus({ ...this.status, state: "QR_PENDING", qrCodeDataUrl });
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
          this.setStatus({
            state: "CONNECTED",
            qrCodeDataUrl: null,
            pairingCode: null,
            connectedNumber,
            lastConnectedAt: new Date(),
          });
        }

        if (connection === "close") {
          if (this.shuttingDown) return; // see endForShutdown() — leave status/DB alone, this process is exiting
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          // WhatsApp always closes the connection once with "restart
          // required" (515) right after requestPairingCode() succeeds —
          // documented, expected multi-device protocol behavior, not a
          // failure: the phone is still showing the code and waiting for
          // it to be typed in, and the client is simply meant to
          // reconnect. Tearing the status down to DISCONNECTED here wiped
          // the just-generated pairingCode for the whole reconnect delay
          // (and permanently once retries ran out) — from the admin's
          // side the code flashed on screen for an instant and then
          // vanished for good. While this fresh pairing-code attempt is
          // still within its retry budget, leave the status (and the
          // code still shown to the admin) alone; connect()'s own
          // CONNECTING reset takes over once the reconnect actually runs
          // moments later and requests a fresh code. QR-code connects are
          // unaffected — this only applies to a phone-number attempt.
          const isExpectedPairingRestart =
            shouldReconnect &&
            statusCode === DisconnectReason.restartRequired &&
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
            this.logger.warn(
              { statusCode, isExpectedPairingRestart, reconnectAttempts: this.reconnectAttempts },
              "WhatsApp connection closed during a pairing-code attempt"
            );
          }

          if (!isExpectedPairingRestart) {
            this.settleDisconnected();
          }

          if (!shouldReconnect) {
            // WhatsApp itself revoked this session (unlinked from the
            // phone's own "Aparelhos conectados", or logged out) — the
            // credentials saved on disk are now permanently dead. Without
            // clearing them, the *next* connect() attempt would keep
            // seeing `state.creds.registered === true` and silently retry
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
            this.connect(this.lastConnectOptions).catch((err) => this.logger.error({ err }, "WhatsApp reconnect attempt failed"));
          }, delay);
        }
      });

      socket.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        for (const message of messages) {
          await this.handleIncomingMessage(message);
        }
      });

      socket.ev.on("contacts.upsert", (contacts) => this.upsertContacts(contacts));
      socket.ev.on("contacts.update", (contacts) => this.upsertContacts(contacts));

      socket.ev.on("messaging-history.set", ({ contacts, messages }) => {
        this.upsertContacts(contacts);
        const converted: HistoryMessageEvent[] = [];
        for (const message of messages) {
          const chatId = message.key.remoteJid ?? "";
          if (!chatId || isNonCustomerChat(chatId)) continue;
          const entry = convertHistoryMessage(message, chatId);
          if (entry) converted.push(entry);
        }
        if (converted.length > 0 || contacts.length > 0) {
          this.emitter.emit("historySync", {
            contacts: Array.from(this.contacts.values()),
            messages: converted,
          } satisfies HistorySyncEvent);
        }
      });

      socket.ev.on("messages.update", (updates) => {
        for (const update of updates) {
          const receipt = (update.update as any)?.status;
          if (!receipt) continue;
          const status = mapBaileysReceiptToStatus(receipt);
          if (!status) continue;
          this.emitter.emit("delivery", {
            providerMessageId: update.key.id ?? "",
            chatId: update.key.remoteJid ?? "",
            status,
            timestamp: new Date(),
          } satisfies DeliveryEvent);
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

      socket.ev.on("messages.reaction", (reactions) => {
        for (const r of reactions) {
          this.emitter.emit("reaction", {
            providerMessageId: r.key.id ?? "",
            chatId: r.key.remoteJid ?? "",
            emoji: r.reaction.text || null,
            fromPhone: (r.reaction.key?.remoteJid ?? "").split("@")[0],
            timestamp: new Date(),
          } satisfies ReactionEvent);
        }
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
    this.setStatus({
      state: "DISCONNECTED",
      qrCodeDataUrl: null,
      pairingCode: null,
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
    this.settleDisconnected();
  }

  async endForShutdown(): Promise<void> {
    this.shuttingDown = true;
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
          key: { id: options.replyToProviderMessageId, remoteJid: chatId, fromMe: false },
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
    const sent = await socket.sendMessage(chatId, { text }, { quoted: quoted as any });
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
    return { providerMessageId: sent?.key.id ?? "", timestamp: new Date() };
  }

  async sendLocation(chatId: string, latitude: number, longitude: number): Promise<SendResult> {
    const socket = this.requireSocket();
    const sent = await socket.sendMessage(chatId, { location: { degreesLatitude: latitude, degreesLongitude: longitude } });
    return { providerMessageId: sent?.key.id ?? "", timestamp: new Date() };
  }

  async sendContact(chatId: string, vcard: string, displayName: string): Promise<SendResult> {
    const socket = this.requireSocket();
    const sent = await socket.sendMessage(chatId, {
      contacts: { displayName, contacts: [{ vcard }] },
    });
    return { providerMessageId: sent?.key.id ?? "", timestamp: new Date() };
  }

  async sendReaction(chatId: string, providerMessageId: string, emoji: string | null): Promise<void> {
    const socket = this.requireSocket();
    await socket.sendMessage(chatId, {
      react: { text: emoji ?? "", key: { id: providerMessageId, remoteJid: chatId, fromMe: false } },
    });
  }

  async markRead(chatId: string, providerMessageIds: string[]): Promise<void> {
    if (providerMessageIds.length === 0) return;
    const socket = this.requireSocket();
    await socket.readMessages(providerMessageIds.map((id) => ({ remoteJid: chatId, id, fromMe: false })));
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

  async syncHistory(): Promise<void> {
    // Baileys can sync history via syncFullHistory during pairing; on-demand
    // backfill for an already-linked session is intentionally not enabled
    // by default (large payloads, WhatsApp rate limits). Documented as a
    // roadmap item — see docs/whatsapp-integration.md.
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

  private upsertContacts(contacts: Array<{ id?: string; jid?: string; name?: string | null; notify?: string | null; imgUrl?: string | null }>) {
    for (const c of contacts) {
      if (!c.id || isNonCustomerChat(c.id)) continue;
      // `id` is `@lid` (an opaque privacy identifier, not a phone number)
      // for a growing share of contacts — Baileys separately hands back the
      // real phone-number JID as `jid` whenever it knows it.
      const phone = (c.jid ?? c.id).split("@")[0];
      const existing = this.contacts.get(phone);
      this.contacts.set(phone, {
        phone,
        name: c.name ?? c.notify ?? existing?.name ?? null,
        photoUrl: (c.imgUrl && c.imgUrl !== "changed" ? c.imgUrl : existing?.photoUrl) ?? null,
      });
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
      if (c.id.endsWith("@lid") && c.jid && phone !== c.id.split("@")[0]) {
        this.emitter.emit("chatIdentityResolved", { chatId: c.id, phone } satisfies ChatIdentityResolvedEvent);
      }
    }
    this.persistContactsCache();
  }

  private async handleIncomingMessage(message: WAMessage): Promise<void> {
    // Previously dropped every fromMe message outright to avoid the app
    // double-recording its own sends — but that also silently dropped
    // every message sent directly from the linked phone (or any other
    // linked device), since WhatsApp's protocol marks both cases fromMe
    // identically. The consumer now de-duplicates by providerMessageId
    // instead — see fromMe on InboundMessageEvent.
    const chatId = message.key.remoteJid ?? "";
    if (!chatId || isNonCustomerChat(chatId)) return; // ignore groups, status updates, broadcast lists, channels

    const content = message.message;
    if (!content) return;

    const quotedStory = extractQuotedStory(content);
    const base = {
      providerMessageId: message.key.id ?? "",
      chatId,
      phone: phoneFromJid(chatId, message.key.senderPn ?? message.key.participantPn),
      // pushName on a fromMe message is this account's own name, not the
      // customer's — never let it overwrite the contact's stored name.
      contactName: message.key.fromMe ? null : (message.pushName ?? null),
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

    if (content.pollCreationMessage) {
      this.emitter.emit("message", {
        ...base,
        type: "POLL",
        body: null,
        pollQuestion: content.pollCreationMessage.name ?? "",
        pollOptions: (content.pollCreationMessage.options ?? []).map((o) => o.optionName ?? "").filter(Boolean),
      } satisfies InboundMessageEvent);
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

    const mediaType = content.imageMessage
      ? "IMAGE"
      : content.videoMessage
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
          content.imageMessage ?? content.videoMessage ?? content.audioMessage ?? content.documentMessage;
        this.emitter.emit("message", {
          ...base,
          type: mediaType,
          body: (content.imageMessage?.caption || content.videoMessage?.caption) ?? null,
          mediaBuffer: buffer,
          mediaMimeType: mediaMsg?.mimetype ?? "application/octet-stream",
          mediaFileName: (content.documentMessage as any)?.fileName ?? undefined,
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
  return chatId.endsWith("@g.us") || chatId.endsWith("@broadcast") || chatId.endsWith("@newsletter");
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
function convertHistoryMessage(message: WAMessage, chatId: string): HistoryMessageEvent | null {
  const content = message.message;
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
  if (content.pollCreationMessage) {
    return {
      ...base,
      type: "POLL",
      body: null,
      pollQuestion: content.pollCreationMessage.name ?? "",
      pollOptions: (content.pollCreationMessage.options ?? []).map((o) => o.optionName ?? "").filter(Boolean),
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
  if (content.videoMessage) return { ...base, type: "VIDEO", body: content.videoMessage.caption ?? null };
  if (content.audioMessage) return { ...base, type: "AUDIO", body: null };
  if (content.documentMessage) return { ...base, type: "DOCUMENT", body: content.documentMessage.title ?? null };
  return null;
}

function mapBaileysReceiptToStatus(receipt: number): DeliveryEvent["status"] | null {
  // Baileys WAMessageStatus enum: 0 ERROR,1 PENDING,2 SERVER_ACK,3 DELIVERY_ACK,4 READ,5 PLAYED
  switch (receipt) {
    case 3:
      return "DELIVERED";
    case 4:
    case 5:
      return "READ";
    case 0:
      return "FAILED";
    default:
      return null;
  }
}
