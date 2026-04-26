-- CreateEnum for service types
CREATE TYPE "ServiceType" AS ENUM ('REALTIME_NODE', 'VENUE_HOSTING');
CREATE TYPE "ServerStatus" AS ENUM ('active', 'inactive', 'maintenance', 'deprovisioning');
CREATE TYPE "ServiceStatus" AS ENUM ('active', 'suspended', 'cancelled');

-- VenueChat Server (represents a node in the cluster)
CREATE TABLE "Server" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL UNIQUE,
    "name" TEXT NOT NULL,
    "status" "ServerStatus" NOT NULL DEFAULT 'active',
    "ipAddress" TEXT,
    "region" TEXT,
    "maxConcurrentUsers" INTEGER NOT NULL DEFAULT 150,
    "maxChunksPerMinute" INTEGER NOT NULL DEFAULT 1200,
    "maxActiveVenues" INTEGER NOT NULL DEFAULT 40,
    "whmcsServerId" TEXT UNIQUE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deactivatedAt" TIMESTAMP(3),
    
    CONSTRAINT "Server_nodeId_unique" UNIQUE ("nodeId")
);

-- Service (purchased through WHMCS on a Server)
CREATE TABLE "Service" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "serviceType" "ServiceType" NOT NULL,
    "status" "ServiceStatus" NOT NULL DEFAULT 'active',
    "billingReference" TEXT NOT NULL UNIQUE,
    "whmcsServiceId" TEXT UNIQUE,
    "whmcsProductId" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "suspendedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    
    FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE,
    CONSTRAINT "Service_billingReference_unique" UNIQUE ("billingReference"),
    CONSTRAINT "Service_whmcsServiceId_unique" UNIQUE ("whmcsServiceId")
);

-- ServiceVenue (links a VENUE_HOSTING service to a venue)
CREATE TABLE "ServiceVenue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serviceId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE,
    CONSTRAINT "ServiceVenue_serviceId_venueId_unique" UNIQUE ("serviceId", "venueId")
);

-- ServiceUsage (tracks billing metrics per service)
CREATE TABLE "ServiceUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serviceId" TEXT NOT NULL,
    "billingPeriodId" TEXT NOT NULL,
    "secondsProcessed" FLOAT NOT NULL DEFAULT 0,
    "concurrentUserPeak" INTEGER NOT NULL DEFAULT 0,
    "translationLanguageCount" INTEGER NOT NULL DEFAULT 0,
    "overage" FLOAT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    
    FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE,
    FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod"("id") ON DELETE CASCADE,
    CONSTRAINT "ServiceUsage_serviceId_billingPeriodId_unique" UNIQUE ("serviceId", "billingPeriodId")
);

-- Link Venue to Services (a venue can have multiple services, like realtime + hosting)
CREATE TABLE "VenueService" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "venueId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE,
    CONSTRAINT "VenueService_venueId_serviceId_unique" UNIQUE ("venueId", "serviceId")
);

-- WhmcsSync enhancements for tracking server/service syncs
ALTER TABLE "WhmcsSyncRecord" ADD COLUMN "recordType" TEXT DEFAULT 'billing'; -- 'billing', 'server', 'service'
ALTER TABLE "WhmcsSyncRecord" ADD COLUMN "externalRecordId" TEXT;

-- Indexes for performance
CREATE INDEX "Server_status" ON "Server"("status");
CREATE INDEX "Service_serverId_status" ON "Service"("serverId", "status");
CREATE INDEX "Service_whmcsServiceId" ON "Service"("whmcsServiceId");
CREATE INDEX "ServiceVenue_serviceId" ON "ServiceVenue"("serviceId");
CREATE INDEX "ServiceVenue_venueId" ON "ServiceVenue"("venueId");
CREATE INDEX "VenueService_venueId" ON "VenueService"("venueId");
CREATE INDEX "ServiceUsage_serviceId_billingPeriodId" ON "ServiceUsage"("serviceId", "billingPeriodId");
CREATE INDEX "WhmcsSync_externalRecordId" ON "WhmcsSyncRecord"("externalRecordId");
