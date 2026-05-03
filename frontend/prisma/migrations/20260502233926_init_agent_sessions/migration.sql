-- CreateTable
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT 1,
    "policyRoot" TEXT,
    "policyURI" TEXT,
    "lastDecision" JSONB,
    "lastTxHash" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentSession_walletAddress_key" ON "AgentSession"("walletAddress");
