-- Hybrid IDs: every table keeps its UUID "id" primary key (used by the API,
-- URLs and all foreign keys) and gains a human-friendly sequential "seq"
-- column (1, 2, 3...) just for looking rows up by hand, e.g.:
--   SELECT * FROM "Conversation" WHERE seq = 152;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "PauseReason" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "AgentStatusLog" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "PasswordResetToken" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "WhatsAppConnection" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ManagerConnectionAccess" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "QuickReply" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "AutoMessageTemplate" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "WorkSchedule" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ClosingMessage" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "QueueWaitMessage" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "MessageTemplate" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "MetaConnection" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ConversationAssignment" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ConversationTransfer" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ConversationEvent" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "MessageAttachment" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "MessageReaction" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "RolePermission" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "Holiday" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "HolidaySyncCursor" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "Flow" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "FlowConnection" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "FlowNode" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "FlowEdge" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "FlowSession" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ConversationNote" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "Tag" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "PendingAutoMessage" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "AutoMessageBlockLog" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "PollVote" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ContactNameChange" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "SatisfactionSurveyConfig" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "SatisfactionQuestion" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "SatisfactionSurvey" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ReleaseNoteVersion" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ColumnView" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ConversationReminder" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ScheduledMessage" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "Goal" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "DataSource" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "DataSourceRow" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ChatRoom" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ChatMember" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ChatReadMark" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ChatDeliveryMark" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ChatMessageEdit" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ChatReaction" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ChatPoll" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ChatPollOption" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ChatPollVote" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ChatPin" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ChatMessageView" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "BoletoLayout" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "BoletoInstruction" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "BirthdayMessage" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "BirthdayGreeting" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "Announcement" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "AnnouncementReceipt" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "AnnouncementDelivery" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "AnnouncementReaction" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ReportSchedule" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ReportScheduleRun" ADD COLUMN     "seq" SERIAL NOT NULL;

-- Backfill: adding a SERIAL column numbers existing rows in arbitrary
-- (physical) order. Renumber them chronologically instead, so seq 1 is the
-- oldest record of each table, then point each sequence right after the
-- highest value so new rows continue from there. The ordering column is
-- picked per table: "createdAt" if present, else another known creation
-- timestamp, else the table's first timestamp column, else just "id".
-- Runs before the unique indexes below are created, so the renumbering
-- can't collide midway.
DO $$
DECLARE
  t   RECORD;
  ord TEXT;
BEGIN
  FOR t IN
    SELECT c.table_name AS tbl
      FROM information_schema.columns c
     WHERE c.table_schema = current_schema()
       AND c.column_name = 'seq'
  LOOP
    SELECT col.column_name INTO ord
      FROM information_schema.columns col
     WHERE col.table_schema = current_schema()
       AND col.table_name = t.tbl
       AND col.data_type LIKE 'timestamp%'
     ORDER BY CASE col.column_name
                WHEN 'createdAt' THEN 0
                WHEN 'firstConversationAt' THEN 1
                WHEN 'startedAt' THEN 2
                WHEN 'sentAt' THEN 3
                WHEN 'syncedAt' THEN 4
                WHEN 'updatedAt' THEN 6
                ELSE 5
              END,
              col.ordinal_position
     LIMIT 1;

    IF ord IS NULL THEN
      EXECUTE format(
        'UPDATE %1$I AS x SET seq = r.rn
           FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM %1$I) AS r
          WHERE x.id = r.id',
        t.tbl);
    ELSE
      EXECUTE format(
        'UPDATE %1$I AS x SET seq = r.rn
           FROM (SELECT id, row_number() OVER (ORDER BY %2$I NULLS LAST, id) AS rn FROM %1$I) AS r
          WHERE x.id = r.id',
        t.tbl, ord);
    END IF;

    EXECUTE format(
      'SELECT setval(pg_get_serial_sequence(%1$L, ''seq''), COALESCE((SELECT max(seq) FROM %2$I), 0) + 1, false)',
      format('%I', t.tbl), t.tbl);
  END LOOP;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX "User_seq_key" ON "User"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "PauseReason_seq_key" ON "PauseReason"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "AgentStatusLog_seq_key" ON "AgentStatusLog"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_seq_key" ON "PasswordResetToken"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_seq_key" ON "RefreshToken"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConnection_seq_key" ON "WhatsAppConnection"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ManagerConnectionAccess_seq_key" ON "ManagerConnectionAccess"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "QuickReply_seq_key" ON "QuickReply"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "AutoMessageTemplate_seq_key" ON "AutoMessageTemplate"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "WorkSchedule_seq_key" ON "WorkSchedule"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ClosingMessage_seq_key" ON "ClosingMessage"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "QueueWaitMessage_seq_key" ON "QueueWaitMessage"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_seq_key" ON "MessageTemplate"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "MetaConnection_seq_key" ON "MetaConnection"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_seq_key" ON "Contact"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_seq_key" ON "Conversation"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationAssignment_seq_key" ON "ConversationAssignment"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationTransfer_seq_key" ON "ConversationTransfer"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationEvent_seq_key" ON "ConversationEvent"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "Message_seq_key" ON "Message"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "MessageAttachment_seq_key" ON "MessageAttachment"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "MessageReaction_seq_key" ON "MessageReaction"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_seq_key" ON "AuditLog"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_seq_key" ON "Notification"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_seq_key" ON "RolePermission"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "Holiday_seq_key" ON "Holiday"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "HolidaySyncCursor_seq_key" ON "HolidaySyncCursor"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "Flow_seq_key" ON "Flow"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "FlowConnection_seq_key" ON "FlowConnection"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "FlowNode_seq_key" ON "FlowNode"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "FlowEdge_seq_key" ON "FlowEdge"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "FlowSession_seq_key" ON "FlowSession"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationNote_seq_key" ON "ConversationNote"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_seq_key" ON "Tag"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "PendingAutoMessage_seq_key" ON "PendingAutoMessage"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "AutoMessageBlockLog_seq_key" ON "AutoMessageBlockLog"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "PollVote_seq_key" ON "PollVote"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ContactNameChange_seq_key" ON "ContactNameChange"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "SatisfactionSurveyConfig_seq_key" ON "SatisfactionSurveyConfig"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "SatisfactionQuestion_seq_key" ON "SatisfactionQuestion"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "SatisfactionSurvey_seq_key" ON "SatisfactionSurvey"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseNoteVersion_seq_key" ON "ReleaseNoteVersion"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ColumnView_seq_key" ON "ColumnView"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationReminder_seq_key" ON "ConversationReminder"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledMessage_seq_key" ON "ScheduledMessage"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "Goal_seq_key" ON "Goal"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "DataSource_seq_key" ON "DataSource"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "DataSourceRow_seq_key" ON "DataSourceRow"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatRoom_seq_key" ON "ChatRoom"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMember_seq_key" ON "ChatMember"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatReadMark_seq_key" ON "ChatReadMark"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatDeliveryMark_seq_key" ON "ChatDeliveryMark"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_seq_key" ON "ChatMessage"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessageEdit_seq_key" ON "ChatMessageEdit"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatReaction_seq_key" ON "ChatReaction"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatPoll_seq_key" ON "ChatPoll"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatPollOption_seq_key" ON "ChatPollOption"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatPollVote_seq_key" ON "ChatPollVote"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatPin_seq_key" ON "ChatPin"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessageView_seq_key" ON "ChatMessageView"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "BoletoLayout_seq_key" ON "BoletoLayout"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "BoletoInstruction_seq_key" ON "BoletoInstruction"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "BirthdayMessage_seq_key" ON "BirthdayMessage"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "BirthdayGreeting_seq_key" ON "BirthdayGreeting"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "Announcement_seq_key" ON "Announcement"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementReceipt_seq_key" ON "AnnouncementReceipt"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementDelivery_seq_key" ON "AnnouncementDelivery"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementReaction_seq_key" ON "AnnouncementReaction"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ReportSchedule_seq_key" ON "ReportSchedule"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ReportScheduleRun_seq_key" ON "ReportScheduleRun"("seq");


