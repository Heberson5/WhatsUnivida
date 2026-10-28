-- CreateEnum
CREATE TYPE "GoalType" AS ENUM ('CLOSED_PER_DAY', 'AVG_FIRST_RESPONSE', 'NPS');

-- CreateEnum
CREATE TYPE "GoalScope" AS ENUM ('ALL', 'CONNECTIONS', 'AGENTS');

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "type" "GoalType" NOT NULL,
    "target" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "scope" "GoalScope" NOT NULL DEFAULT 'ALL',
    "connectionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);


-- The old single "meta diária" (business settings) becomes the first goal.
INSERT INTO "Goal" ("id", "type", "target", "active", "scope", "updatedAt")
SELECT gen_random_uuid()::text, 'CLOSED_PER_DAY', ("value"->>'dailyConversationGoal')::int, true, 'ALL', CURRENT_TIMESTAMP
FROM "SystemSetting"
WHERE "key" = 'business' AND jsonb_typeof("value"->'dailyConversationGoal') = 'number';
