-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "stripePaymentIntentId" TEXT;

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "orderId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_events_orderId_idx" ON "webhook_events"("orderId");

-- CreateIndex
CREATE INDEX "webhook_events_appliedAt_idx" ON "webhook_events"("appliedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_eventId_key" ON "webhook_events"("provider", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_stripePaymentIntentId_key" ON "orders"("stripePaymentIntentId");
