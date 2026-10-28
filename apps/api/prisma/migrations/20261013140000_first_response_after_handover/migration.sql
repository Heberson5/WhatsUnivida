-- "1ª resposta" came out negative: a handover (transfer, @menção, back to the queue) renewed acceptedAt but kept
-- the previous agent's firstResponseAt. Those values don't belong to the current acceptance — drop them.
UPDATE "Conversation" SET "firstResponseAt" = NULL WHERE "firstResponseAt" < "acceptedAt";
