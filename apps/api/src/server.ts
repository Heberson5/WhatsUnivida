import http from "node:http";
import { createApp } from "./app";
import { createSocketServer } from "./realtime/socket-server";
import { initWhatsAppConnections, shutdownAllConnections } from "./modules/whatsapp/whatsapp.service";
import { requeueUnansweredDeviceConversations, revertExpiredTransfers } from "./modules/conversations/conversations.service";
import { syncDueDataSources } from "./modules/data-sources/data-sources.service";
import { realtimeEvents } from "./realtime/realtime";
import { processDueClosingMessages } from "./modules/satisfaction/satisfaction.service";
import { runHolidaySyncIfDue } from "./modules/holidays/holidays.service";
import { sendNoReplyRemindersIfDue, sendQueueRemindersIfDue } from "./lib/queue-reminder";
import { processNoReturnConversations } from "./modules/conversations/no-return.service";
import { sendQueueWaitMessages } from "./modules/queue-wait-messages/queue-wait.sweep";
import { processDueAutoMessages } from "./lib/auto-messages";
import { endIdleSessions } from "./modules/auth/auth.service";
import { fillShippedNoteImages, syncDefaultReleaseNotes } from "./modules/release-notes/release-notes.service";
import { ensureBoletoDefaults } from "./modules/boletos/boleto-layouts.service";
import { syncDefaultFlows } from "./modules/flows/default-flows";
import { syncContactsIfDue } from "./lib/contacts-sync";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { fireDueReminders, sendDueScheduledMessages } from "./modules/agent-tools/agent-tools.service";
import { abandonIdleFlowSessions, dispatchWaitingTransfers } from "./modules/flows/flow-engine.service";

const AGENT_TOOLS_SWEEP_INTERVAL_MS = 20_000;

const TRANSFER_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // see PROMPT: revert an unaccepted offline transfer after 2h
// Cheap to check daily — runHolidaySyncIfDue itself only does real work
// (a BrasilAPI fetch for national holidays — estadual/municipal stay
// manual-only, see PROMPT: "deixe o cadastro de feriado municipal
// manual") once its own ~monthly cadence marker says it's due, so most
// days this is a single no-op SystemSetting read.
const HOLIDAY_SYNC_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// The admin-configured queueReminderIntervalMinutes (default 1 minute)
// decides the real cadence via sendQueueRemindersIfDue's own marker — this
// is just how often it's cheap to check whether it's due yet. See PROMPT:
// "notificações a cada um minuto quando tem conversas na fila".
const QUEUE_REMINDER_CHECK_INTERVAL_MS = 60 * 1000;

// Sessions left without use past Configurações › Sessão's limit (see endIdleSessions).
const IDLE_SESSION_SWEEP_INTERVAL_MS = 60 * 1000;

// Looks for connections that missed the Monday 00:00 address-book load (or never had one).
const CONTACTS_SYNC_CHECK_INTERVAL_MS = 10 * 60 * 1000;

// The closing message that waits on a satisfaction survey goes out 10 seconds after the customer's
// score — so the check has to be much finer than the other sweeps.
const CLOSING_MESSAGE_SWEEP_INTERVAL_MS = 5 * 1000;

async function main() {
  // Presence is otherwise only ever kept correct by live socket connections
  // (see socket-server.ts) — but this process's own in-memory tracking of
  // those starts empty on every boot, so a row left ONLINE by a previous
  // process that didn't get to shut down cleanly (a crash, a host reboot)
  // would otherwise sit there forever with nothing to ever correct it.
  // Anyone actually still connected reconnects their socket within moments
  // of this process coming up and gets marked ONLINE again right away.
  await prisma.user.updateMany({ where: { presence: { not: "OFFLINE" } }, data: { presence: "OFFLINE" } });

  // The release notes shipped with this version — each one copied into the database once (see syncDefaultReleaseNotes).
  await syncDefaultReleaseNotes().catch((err) => logger.error({ err }, "failed to copy the shipped release notes"));
  await fillShippedNoteImages().catch((err) => logger.error({ err }, "failed to fill in the screenshots of shipped release notes"));
  // Dados › Layouts and Mensagens do boleto start with the Banco do Brasil layouts and "Instruções padrão".
  await ensureBoletoDefaults();
  // Flows shipped with this version (e.g. Univida) — copied in once, switched off and with no connection.
  await syncDefaultFlows().catch((err) => logger.error({ err }, "failed to copy the shipped flows"));

  const app = createApp();
  const httpServer = http.createServer(app);
  createSocketServer(httpServer);

  await initWhatsAppConnections();

  const transferSweepTimer = setInterval(() => {
    revertExpiredTransfers().catch((err) => logger.error({ err }, "failed to sweep expired transfers"));
  }, TRANSFER_SWEEP_INTERVAL_MS);
  transferSweepTimer.unref(); // never keeps the process alive by itself

  const holidaySyncTimer = setInterval(() => {
    runHolidaySyncIfDue().catch((err) => logger.error({ err }, "failed to run the periodic holiday sync check"));
  }, HOLIDAY_SYNC_CHECK_INTERVAL_MS);
  holidaySyncTimer.unref();
  // Also checked once right at boot — a deploy that stays up for weeks at a
  // time shouldn't have to wait a full day for the first check.
  runHolidaySyncIfDue().catch((err) => logger.error({ err }, "failed to run the startup holiday sync check"));

  const queueReminderTimer = setInterval(() => {
    sendQueueRemindersIfDue().catch((err) => logger.error({ err }, "failed to check/send queue reminders"));
    sendNoReplyRemindersIfDue().catch((err) => logger.error({ err }, "failed to check/send no-reply reminders"));
    processNoReturnConversations().catch((err) => logger.error({ err }, "failed to process falta de retorno"));
    sendQueueWaitMessages().catch((err) => logger.error({ err }, "failed to send the queue wait messages"));
  }, QUEUE_REMINDER_CHECK_INTERVAL_MS);
  queueReminderTimer.unref();

  // Conversations started on the linked phone whose customer is left without an answer come to the queue.
  // Fontes de dados: refreshes the active spreadsheet/database when its interval is due.
  const dataSourceTimer = setInterval(() => {
    syncDueDataSources().catch((err) => logger.error({ err }, "data source sync timer failed"));
  }, 60_000);
  dataSourceTimer.unref();

  const deviceRequeueTimer = setInterval(() => {
    requeueUnansweredDeviceConversations()
      .then((requeued) => {
        for (const c of requeued) realtimeEvents.newQueueConversation(c.whatsappConnectionId, c.id, c.contactName);
      })
      .catch((err) => logger.error({ err }, "failed to send unanswered phone conversations to the queue"));
  }, QUEUE_REMINDER_CHECK_INTERVAL_MS);
  deviceRequeueTimer.unref();

  const idleSessionTimer = setInterval(() => {
    endIdleSessions().catch((err) => logger.error({ err }, "failed to end idle sessions"));
  }, IDLE_SESSION_SWEEP_INTERVAL_MS);
  idleSessionTimer.unref();

  const contactsSyncTimer = setInterval(() => {
    syncContactsIfDue().catch((err) => logger.error({ err }, "failed to run the weekly address book sync"));
  }, CONTACTS_SYNC_CHECK_INTERVAL_MS);
  contactsSyncTimer.unref();

  // Kept in the database (not in a timer), so a restart in the middle of the wait loses nothing. The guard
  // only avoids piling sweeps up behind a slow send — a message is claimed atomically either way.
  let closingSweepRunning = false;
  const closingMessageTimer = setInterval(() => {
    if (closingSweepRunning) return;
    closingSweepRunning = true;
    processDueClosingMessages()
      .catch((err) => logger.error({ err }, "failed to send the closing messages that were due"))
      .finally(() => {
        closingSweepRunning = false;
      });
  }, CLOSING_MESSAGE_SWEEP_INTERVAL_MS);
  closingMessageTimer.unref();

  // Automatic messages waiting their 3–10 seconds (lib/auto-messages.ts) — kept in the database, so a restart loses nothing.
  let autoMessagesSweepRunning = false;
  const autoMessagesTimer = setInterval(() => {
    if (autoMessagesSweepRunning) return;
    autoMessagesSweepRunning = true;
    processDueAutoMessages()
      .catch((err) => logger.error({ err }, "failed to send the automatic messages that were due"))
      .finally(() => {
        autoMessagesSweepRunning = false;
      });
  }, 1_000);
  autoMessagesTimer.unref();

  // "Lembrar de retornar" and "Agendar envio" — both kept in the database, so a restart loses nothing.
  let agentToolsSweepRunning = false;
  const agentToolsTimer = setInterval(() => {
    if (agentToolsSweepRunning) return;
    agentToolsSweepRunning = true;
    // Also the Fluxo's clock: menus left unanswered go to Abandonados, and transfers waiting for someone online are handed over.
    Promise.all([fireDueReminders(), sendDueScheduledMessages(), abandonIdleFlowSessions(), dispatchWaitingTransfers()])
      .catch((err) => logger.error({ err }, "failed to fire reminders / send scheduled messages"))
      .finally(() => {
        agentToolsSweepRunning = false;
      });
  }, AGENT_TOOLS_SWEEP_INTERVAL_MS);
  agentToolsTimer.unref();

  httpServer.listen(env.PORT, () => {
    logger.info(`API listening on port ${env.PORT} (env=${env.NODE_ENV}, whatsapp=${env.WHATSAPP_PROVIDER})`);
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    clearInterval(transferSweepTimer);
    clearInterval(holidaySyncTimer);
    clearInterval(queueReminderTimer);
    clearInterval(deviceRequeueTimer);
    clearInterval(dataSourceTimer);
    clearInterval(idleSessionTimer);
    clearInterval(contactsSyncTimer);
    clearInterval(closingMessageTimer);
    clearInterval(autoMessagesTimer);
    clearInterval(agentToolsTimer);
    httpServer.close();
    // Every deploy sends this signal to the outgoing container — ending
    // each WhatsApp connection's socket cleanly here (rather than letting
    // the process just die under it) avoids corrupting WhatsApp's own
    // multi-device sync to the linked phone. See shutdownAllConnections.
    await shutdownAllConnections();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
