-- Data cleanup only — no table changes.
--
-- Every reaction an agent clicked in Atendimento used to come back from WhatsApp
-- as an echo that was stored a second time as the CUSTOMER's reaction, so the
-- message showed the same emoji twice ("Ana" + a phantom "Cliente"). The echo is
-- recognizable: same message, same emoji, created within seconds of the agent's
-- own reaction. Those copies are removed here; a customer reaction with another
-- emoji, or made well after the agent's, is real and stays.
DELETE FROM "MessageReaction" AS echo
USING "MessageReaction" AS agent
WHERE echo."fromCustomer" = true
  AND echo."userId" IS NULL
  AND agent."fromCustomer" = false
  AND agent."userId" IS NOT NULL
  AND agent."messageId" = echo."messageId"
  AND agent."emoji" = echo."emoji"
  AND echo."createdAt" >= agent."createdAt"
  AND echo."createdAt" <= agent."createdAt" + INTERVAL '30 seconds';
