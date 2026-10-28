export type WhatsAppConnectionState = "DISCONNECTED" | "CONNECTING" | "QR_PENDING" | "CODE_PENDING" | "CONNECTED";

export interface WhatsAppStatusSnapshot {
  state: WhatsAppConnectionState;
  qrCodeDataUrl: string | null;
  // Set only while state === "CODE_PENDING" — the WhatsApp-Web-style linking
  // code the operator types into Settings > Linked Devices > Link with phone
  // number, as an alternative to scanning a QR code.
  pairingCode: string | null;
  /** When the pairing code on screen stops being valid — a new one replaces it then, straight away. */
  pairingCodeExpiresAt?: Date | null;
  /** The number the pairing code was requested for (to ask for a new one). */
  pairingPhoneNumber?: string | null;
  connectedNumber: string | null;
  lastConnectedAt: Date | null;
}

export interface ConnectOptions {
  /** When set, requests a pairing code for this phone number instead of a QR code. */
  phoneNumber?: string;
}

/**
 * A menu sent as WhatsApp's own buttons (up to 3) or a list (up to 10 rows) — API Oficial only. Tapping one comes
 * back as an inbound message whose `selectedOptionId` is the option's id.
 */
export interface OutboundMenu {
  body: string;
  options: { id: string; label: string }[];
  /** Shown above the buttons (buttons only — a list has no picture). */
  image?: { buffer: Buffer; fileName: string; mimeType: string };
  /** The list's button and the title above its rows. */
  listButton?: string;
  listTitle?: string;
}

export interface InboundMessageEvent {
  providerMessageId: string;
  chatId: string; // provider-native chat/contact id (e.g. "5511999999999@s.whatsapp.net")
  phone: string; // normalized E.164-ish digits
  contactName: string | null;
  type: "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "LOCATION" | "CONTACT" | "POLL" | "EVENT";
  body: string | null;
  /** The id of the reply button or list row the customer tapped (API Oficial) — `body` holds its title. */
  selectedOptionId?: string | null;
  mediaBuffer?: Buffer;
  mediaMimeType?: string;
  mediaFileName?: string;
  /** A WhatsApp GIF: a short silent video that plays by itself, in a loop (videoMessage.gifPlayback). */
  mediaIsGif?: boolean;
  latitude?: number;
  longitude?: number;
  vcard?: string;
  /** POLL only — the question and options come in plaintext; the votes (later messages) are read with pollSecret. */
  pollQuestion?: string;
  pollOptions?: string[];
  /** POLL only: 1 = single choice, otherwise several answers allowed. */
  pollSelectableCount?: number;
  /** POLL only: base64 key the votes are encrypted with, and who created the poll as the encryption names them. */
  pollSecret?: string | null;
  pollCreatorJid?: string | null;
  /** EVENT only ("lembrete"/"evento" in WhatsApp's own Portuguese UI). */
  eventName?: string;
  eventDescription?: string;
  eventStartAt?: Date;
  eventJoinLink?: string;
  replyToProviderMessageId?: string | null;
  /**
   * Set when this message replies to a WhatsApp Status/Story rather than to
   * another message in the conversation (contextInfo.remoteJid ===
   * "status@broadcast"). The story itself is never fetched or stored
   * anywhere — WhatsApp doesn't keep it once it expires and there is no way
   * to look one up afterward — so this only carries the small preview
   * WhatsApp embeds directly inside the reply itself: the story's own text,
   * or a low-res thumbnail for a media story.
   */
  isQuotedStoryReply?: boolean;
  quotedStoryText?: string | null;
  quotedStoryThumbnailBase64?: string | null;
  /**
   * Link-preview card (WhatsApp Web parity) — populated when this TEXT
   * message's body contains a URL and either the sender's own phone (any
   * inbound or device-sent message) or, for a message sent through this
   * app, Baileys' own getUrlInfo helper (see sendText in
   * BaileysWhatsAppProvider) generated Open Graph metadata for it.
   */
  linkPreviewTitle?: string | null;
  linkPreviewDescription?: string | null;
  /** The literal URL the preview refers to (WhatsApp's own "matched text") — used as the card's href. */
  linkPreviewUrl?: string | null;
  linkPreviewThumbnailBase64?: string | null;
  timestamp: Date;
  // true when this message was sent BY the connected account rather than
  // received from the customer — WhatsApp's multi-device protocol reports
  // this the same way whether it was sent through this app or directly
  // from the linked phone (or any other linked session). A message this
  // app itself just sent also echoes back through here; the consumer is
  // responsible for recognizing (by providerMessageId) that it already
  // recorded that one and skipping it, rather than filtering fromMe out
  // entirely — that would silently drop every message sent from the phone.
  fromMe: boolean;
  /**
   * Set only for a message in a WhatsApp group (chatId ends in "@g.us"):
   * who in the group wrote it. `phone` stays the group's own id digits there
   * — a group has no phone number — so it must never be used as a customer.
   * Absent for every 1:1 chat.
   */
  group?: GroupMessageSender;
}

/** Who wrote a group message. `participantPhone` is null when WhatsApp only gave an opaque @lid id. */
export interface GroupMessageSender {
  participantJid: string;
  participantPhone: string | null;
  participantName: string | null;
}

export interface GroupParticipant {
  jid: string;
  phone: string | null;
  name: string | null;
  isAdmin: boolean;
}

export interface GroupInfo {
  chatId: string;
  subject: string;
  participants: GroupParticipant[];
}

/** The oldest message the app has of a chat — older history is asked for from before it. `participant`: its author, in a group. */
export interface OlderHistoryAnchor {
  providerMessageId: string;
  fromMe: boolean;
  timestamp: Date;
  participant?: string | null;
}

export interface DeliveryEvent {
  providerMessageId: string;
  chatId: string;
  status: "SENT" | "DELIVERED" | "READ" | "FAILED";
  /** FAILED only, when the provider says why — for Baileys, the code in the error ack WhatsApp's server sent back for the message. */
  errorCode?: string;
  timestamp: Date;
}

/** The customer started or stopped typing (or recording audio) in a chat — see subscribeTyping. */
export interface TypingEvent {
  chatId: string;
  typing: boolean;
  /** Typing or recording audio — WhatsApp tells them apart ("composing" / "recording"). */
  kind?: "typing" | "recording";
  /** Groups: who of the participants it is. */
  participantJid?: string | null;
  participantPhone?: string | null;
}

/** What the customer's WhatsApp shows of the attendant: "digitando…", "gravando áudio…", or nothing. */
export type OutgoingPresence = "composing" | "recording" | "paused";

/**
 * Someone voted (or changed or took back their vote) in a poll — still encrypted: the poll's own key, kept with the
 * poll message, reads it (decryptPollVoteOptions).
 */
export interface PollVoteEvent {
  chatId: string;
  /** The poll's own provider message id. */
  pollMessageId: string;
  /** The voter as the vote encryption names them (also the key their vote is kept under). */
  voterJid: string;
  /**
   * Other ways WhatsApp may name the voter and the poll's creator (phone number or LID, in a LID group) — the vote is
   * encrypted with one of them; the right one is the one that opens it.
   */
  voterJidCandidates?: string[];
  creatorJidCandidates?: string[];
  voterName: string | null;
  voterPhone: string | null;
  fromMe: boolean;
  encPayload: string;
  encIv: string;
  timestamp: Date;
}

export interface ReactionEvent {
  providerMessageId: string;
  chatId: string;
  emoji: string | null; // null = reaction removed
  fromPhone: string;
  /**
   * The reaction was made by OUR account, not the customer: Baileys echoes
   * everything this app sends (including the reactions an agent clicks here)
   * and also reports the ones made on the linked phone. Absent/false = the
   * customer's own reaction.
   */
  fromMe?: boolean;
  /** In a group: the participant who reacted (their phone, when WhatsApp reveals it). Absent in a 1:1 chat. */
  participant?: { jid: string; phone: string | null } | null;
  timestamp: Date;
}

export interface SendResult {
  providerMessageId: string;
  timestamp: Date;
  /** TEXT sends only — set when the sent text's URL got a generated link-preview card (see sendText). */
  linkPreview?: {
    title: string;
    description?: string | null;
    url: string;
    thumbnailBase64?: string | null;
  } | null;
}

export interface SendTextOptions {
  replyToProviderMessageId?: string;
  // The original message's own text — WhatsApp's protocol requires the
  // quoted message's content alongside its key (not just the key) to
  // render the reply-preview bubble; without it Baileys throws building
  // the outgoing stanza and the reply never reaches WhatsApp at all. Only
  // text sends can be a reply (see the /messages/.../text route), so this
  // is always the replied-to message's plain body.
  replyToText?: string | null;
  /** Replying to a group message: who wrote it — WhatsApp needs the author to find the quoted message in a group. */
  replyToParticipantJid?: string | null;
  /** Group participants marked with "@" (their jids). The text carries "@<number>" for each one shown; a jid with no "@" in the text (marcar todos) is notified without being listed. */
  mentions?: string[];
}

export interface ContactInfo {
  phone: string;
  name: string | null;
  photoUrl: string | null;
}

export interface HistoryMessageEvent {
  providerMessageId: string;
  chatId: string;
  phone: string;
  /** true = sent by the connected number itself (e.g. from the phone, before this system was tracking it); false = from the customer. */
  fromMe: boolean;
  type: "TEXT" | "LOCATION" | "CONTACT" | "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "POLL" | "EVENT";
  body: string | null;
  latitude?: number;
  longitude?: number;
  vcard?: string;
  pollQuestion?: string;
  pollOptions?: string[];
  pollSelectableCount?: number;
  /** POLL only: the key its votes are encrypted with (base64) and its creator — kept so later votes can be read. */
  pollSecret?: string | null;
  pollCreatorJid?: string | null;
  eventName?: string;
  eventDescription?: string;
  eventStartAt?: Date;
  eventJoinLink?: string;
  timestamp: Date;
  /** Group chats only: who wrote it (see InboundMessageEvent.group). */
  group?: GroupMessageSender;
}

/**
 * Chat-level metadata from a history sync — separate from the messages
 * array because unreadCount lives on the chat itself, not on any one
 * message. See PROMPT: "conversas no WhatsApp que não foram lidas não
 * aparecem na fila, pois são conversas que já estavam sem ler antes de
 * conectar o WhatsApp" — this is how the app learns a chat already had
 * unread messages before it was ever linked.
 */
export interface HistoryChatInfo {
  chatId: string;
  unreadCount: number;
}

export interface HistorySyncEvent {
  contacts: ContactInfo[];
  chats: HistoryChatInfo[];
  messages: HistoryMessageEvent[];
}

/**
 * Fired when a chat is marked read from somewhere other than this app —
 * almost always the linked phone itself, via WhatsApp's own multi-device
 * sync. Lets the unread badge here match what the agent already sees on
 * their phone instead of only ever clearing when they open it in this UI.
 */
export interface ChatReadEvent {
  chatId: string;
  phone: string; // normalized E.164-ish digits — see phoneFromJid in BaileysWhatsAppProvider
}

/**
 * Fired when WhatsApp reveals a chat's real phone number after it was
 * first known only by its opaque @lid privacy id — independently of any
 * read-state change. This is the only way a contact ever gets corrected
 * when it was created from a message with no phone-resolvable field at
 * all in the first place (a message sent directly from the linked phone
 * in a brand-new 1:1 chat — senderPn/participantPn are only ever
 * populated for group chats, so that kind of message can't resolve the
 * number on its own no matter what).
 */
export interface ChatIdentityResolvedEvent {
  chatId: string;
  phone: string;
  /** The contact's name as saved in the linked phone's own address book, when known — see BaileysWhatsAppProvider's upsertContacts. */
  name?: string | null;
}

/**
 * WhatsAppProvider is the single seam between the application and any
 * concrete WhatsApp client library. No other module in the app should
 * import a provider implementation directly — only this interface.
 * Swapping providers (e.g. Baileys -> Cloud API) means writing a new
 * class that implements this interface; nothing else changes.
 */
export interface WhatsAppProvider {
  connect(options?: ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Cleanly closes the live connection for a graceful process shutdown
   * (e.g. a deploy) WITHOUT touching the persisted session on disk and
   * WITHOUT transitioning status to DISCONNECTED — unlike disconnect(),
   * which unlinks the account entirely. The next process boot's
   * initWhatsAppConnections() only auto-reconnects a row still recorded
   * as CONNECTED, so this must never persist a status change. Letting the
   * WebSocket instead die from the OS killing the process (no close
   * handshake) is what used to leave WhatsApp's own multi-device sync
   * between this companion session and the primary phone corrupted after
   * every deploy — messages still reached the customer fine, but the
   * phone's own chat history got stuck showing "Aguardando mensagem" for
   * them, and the operator had to manually reconnect (fresh QR/code) to
   * clear it.
   */
  endForShutdown(): Promise<void>;
  getStatus(): WhatsAppStatusSnapshot;

  /** Contacts saved on the linked phone — powers "start a new conversation" from Atendimento. Empty while not CONNECTED. */
  listContacts(): Promise<ContactInfo[]>;

  /**
   * Re-reads the whole address book of the linked phone into what
   * listContacts returns. Meant to run rarely (weekly, or on an admin's
   * request) — between runs the list stays as it was. Cloud API has no
   * address book, so there it just reports 0.
   */
  syncContacts(): Promise<{ count: number }>;

  /**
   * Checks whether a single phone number is registered on WhatsApp — one
   * bounded server query (the same lookup WhatsApp Web's own "start new
   * chat by number" uses), never the linked phone's address book. Safe to
   * call per-keystroke/per-submit in a way a bulk contacts dump is not (see
   * listContacts' own gradual-population note and syncFullHistory's
   * comment in BaileysWhatsAppProvider for why a full sync was reverted).
   * Returns the canonical registered phone when it exists, null otherwise.
   */
  lookupNumber(phone: string): Promise<{ phone: string } | null>;

  sendText(chatId: string, text: string, options?: SendTextOptions): Promise<SendResult>;
  sendFile(
    chatId: string,
    buffer: Buffer,
    fileName: string,
    mimeType: string,
    caption?: string
  ): Promise<SendResult>;
  sendAudio(chatId: string, buffer: Buffer, mimeType: string): Promise<SendResult>;
  sendLocation(chatId: string, latitude: number, longitude: number): Promise<SendResult>;
  sendContact(chatId: string, vcard: string, displayName: string): Promise<SendResult>;
  /**
   * `options.targetFromMe`: the message being reacted to was sent by us (an
   * outbound message), not by the customer — WhatsApp identifies the target by
   * its key, and that key must say who wrote it. Providers that address the
   * message by id alone (Cloud API) ignore it.
   */
  sendReaction(chatId: string, providerMessageId: string, emoji: string | null, options?: { targetFromMe?: boolean }): Promise<void>;

  /**
   * Sends WhatsApp read receipts for the given inbound messages — the same
   * protocol action that (a) shows the customer blue double-check ticks
   * (unless the connected account's own WhatsApp privacy settings have read
   * receipts turned off, in which case WhatsApp itself only syncs step (b)
   * and skips the customer-visible receipt) and (b) clears the unread
   * indicator on every other device linked to this account, including the
   * phone itself. There is no way to request only one of the two — it's a
   * single underlying receipt.
   */
  markRead(chatId: string, providerMessageIds: string[], options?: { participantByMessageId?: Record<string, string> }): Promise<void>;

  /** Every group the linked number is in (empty for providers without groups, like the Cloud API). */
  listGroups(): Promise<GroupInfo[]>;
  /** One group's name and participants, or null when it can't be read. */
  getGroupInfo(chatId: string): Promise<GroupInfo | null>;

  getContactInfo(chatId: string): Promise<ContactInfo>;
  getContactPhoto(chatId: string): Promise<string | null>;

  /**
   * Requests ONE bounded batch of older messages for a single chat,
   * anchored just before a message this app already has — never a
   * blanket/automatic account-wide sync (see BaileysWhatsAppProvider's
   * fetchOlderHistory for the safety rationale). Results, if any, arrive
   * later through onHistorySync below, same as any other history batch —
   * this call only sends the request.
   */
  fetchOlderHistory(chatId: string, anchor: OlderHistoryAnchor, count: number): Promise<void>;

  onConnectionUpdate(listener: (status: WhatsAppStatusSnapshot) => void): void;
  onMessage(listener: (event: InboundMessageEvent) => void): void;
  onDelivery(listener: (event: DeliveryEvent) => void): void;
  onReaction(listener: (event: ReactionEvent) => void): void;
  /** Poll votes (QR Code connections). Optional: the Cloud API does not deliver group polls. */
  onPollVote?(listener: (event: PollVoteEvent) => void): void;
  /**
   * Asks WhatsApp to report when the customer of this chat is typing (it only does so for chats someone asked
   * about, and for a while). A no-op where the channel has no such signal (the Cloud API).
   */
  subscribeTyping(chatId: string): Promise<void>;
  onTyping(listener: (event: TypingEvent) => void): void;
  /** Shows the customer "digitando…" / "gravando áudio…" while the attendant writes or records (a no-op where the channel can't). */
  sendPresence(chatId: string, presence: OutgoingPresence): Promise<void>;
  /** Fired when the linked phone hands over its address book and/or recent chat history — see BaileysWhatsAppProvider for when/why this fires. */
  onHistorySync(listener: (event: HistorySyncEvent) => void): void;
  /** Fired when a chat's unread count drops to zero from outside this app (e.g. read on the linked phone) — see ChatReadEvent. */
  onChatRead(listener: (event: ChatReadEvent) => void): void;
  /** Fired when WhatsApp reveals a chat's real phone number after it was first seen only as an opaque @lid id — see ChatIdentityResolvedEvent. */
  onChatIdentityResolved(listener: (event: ChatIdentityResolvedEvent) => void): void;
}
