-- Assistente Virtual: conversation status while the local AI talks to the customer (out of the queue, like IN_FLOW).
ALTER TYPE "ConversationStatus" ADD VALUE IF NOT EXISTS 'IN_AI' AFTER 'IN_FLOW';
