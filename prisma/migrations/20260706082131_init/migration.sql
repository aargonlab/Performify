-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('MANUAL', 'SCHEDULED', 'THEME_PUBLISH');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "Device" AS ENUM ('MOBILE', 'DESKTOP');

-- CreateEnum
CREATE TYPE "PageType" AS ENUM ('HOME', 'COLLECTION', 'PRODUCT', 'CART', 'PAGE', 'BLOG', 'ARTICLE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ResultStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "timezone" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "settings" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditProfile" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "devices" TEXT[] DEFAULT ARRAY['MOBILE']::TEXT[],
    "runsPerUrl" INTEGER NOT NULL DEFAULT 3,
    "categories" TEXT[] DEFAULT ARRAY['performance', 'accessibility', 'best-practices', 'seo']::TEXT[],
    "markets" JSONB NOT NULL DEFAULT '{"mode":"all","handles":[],"localeMode":"default"}',
    "pages" JSONB NOT NULL DEFAULT '{}',
    "schedule" JSONB NOT NULL DEFAULT '{"enabled":true,"cron":"0 4 1 * *","timezone":"UTC"}',
    "themePublishTrigger" BOOLEAN NOT NULL DEFAULT true,
    "thresholds" JSONB NOT NULL DEFAULT '[]',
    "notifications" JSONB NOT NULL DEFAULT '{"emails":[]}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditRun" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "profileId" TEXT,
    "profileSnapshot" JSONB NOT NULL,
    "trigger" "RunTrigger" NOT NULL,
    "themeId" TEXT,
    "themeName" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "totalJobs" INTEGER NOT NULL DEFAULT 0,
    "completedJobs" INTEGER NOT NULL DEFAULT 0,
    "failedJobs" INTEGER NOT NULL DEFAULT 0,
    "narrative" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AuditRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "pageType" "PageType" NOT NULL,
    "device" "Device" NOT NULL,
    "marketHandle" TEXT,
    "marketName" TEXT,
    "locale" TEXT,
    "label" TEXT,
    "status" "ResultStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "runsRequested" INTEGER NOT NULL DEFAULT 3,
    "runsCompleted" INTEGER NOT NULL DEFAULT 0,
    "performanceScore" INTEGER,
    "accessibilityScore" INTEGER,
    "bestPracticesScore" INTEGER,
    "seoScore" INTEGER,
    "lcpMs" DOUBLE PRECISION,
    "cls" DOUBLE PRECISION,
    "tbtMs" DOUBLE PRECISION,
    "fcpMs" DOUBLE PRECISION,
    "speedIndexMs" DOUBLE PRECISION,
    "ttfbMs" DOUBLE PRECISION,
    "fieldSource" TEXT,
    "fieldLcpMs" INTEGER,
    "fieldInpMs" INTEGER,
    "fieldCls" DOUBLE PRECISION,
    "fieldOverall" TEXT,
    "lighthouseVersion" TEXT,
    "topOpportunities" JSONB,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PageResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawReport" (
    "id" TEXT NOT NULL,
    "pageResultId" TEXT NOT NULL,
    "runIndex" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "json" JSONB NOT NULL,

    CONSTRAINT "RawReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "actual" DOUBLE PRECISION NOT NULL,
    "severity" TEXT NOT NULL,
    "url" TEXT,
    "marketHandle" TEXT,
    "device" "Device",
    "pageType" "PageType",
    "notifiedEmail" BOOLEAN NOT NULL DEFAULT false,
    "notifiedWebhook" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareLink" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE INDEX "AuditProfile_shopId_idx" ON "AuditProfile"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditProfile_shopId_name_key" ON "AuditProfile"("shopId", "name");

-- CreateIndex
CREATE INDEX "AuditRun_shopId_createdAt_idx" ON "AuditRun"("shopId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditRun_profileId_status_idx" ON "AuditRun"("profileId", "status");

-- CreateIndex
CREATE INDEX "PageResult_runId_idx" ON "PageResult"("runId");

-- CreateIndex
CREATE INDEX "PageResult_runId_pageType_device_idx" ON "PageResult"("runId", "pageType", "device");

-- CreateIndex
CREATE UNIQUE INDEX "RawReport_pageResultId_runIndex_key" ON "RawReport"("pageResultId", "runIndex");

-- CreateIndex
CREATE INDEX "Alert_shopId_createdAt_idx" ON "Alert"("shopId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "WebhookEvent_shopDomain_topic_idx" ON "WebhookEvent"("shopDomain", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "ShareLink_token_key" ON "ShareLink"("token");

-- AddForeignKey
ALTER TABLE "AuditProfile" ADD CONSTRAINT "AuditProfile_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditRun" ADD CONSTRAINT "AuditRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditRun" ADD CONSTRAINT "AuditRun_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "AuditProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageResult" ADD CONSTRAINT "PageResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawReport" ADD CONSTRAINT "RawReport_pageResultId_fkey" FOREIGN KEY ("pageResultId") REFERENCES "PageResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
