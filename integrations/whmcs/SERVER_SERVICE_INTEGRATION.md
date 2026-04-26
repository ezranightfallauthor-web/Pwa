# VenueChat Server & Service Architecture

This document explains the WHMCS integration architecture that treats VenueChat nodes as servers with billable services.

## High-Level Architecture

```
WHMCS                          VenueChat Backend
┌─────────────────┐           ┌──────────────────────┐
│  VenueChat Node │  ─ API ─→ │ Server (node-1)      │
│    Product      │           │ - maxConcurrentUsers │
│  (per-node      │           │ - maxChunksPerMin    │
│  infrastructure)│           │ - Services[]         │
└─────────────────┘           └──────────────────────┘
         │                               │
         │                      ┌────────┴────────┐
         │                      │                 │
┌─────────────────────────┐     │         ┌───────────────────┐
│ VenueChat Services      │     │         │ Service 1         │
│ - Realtime Node         │     │         │ (REALTIME_NODE)   │
│ - Venue Hosting         │     │         │ - Status: active  │
│ (add-ons per product)   │     │         │ - whmcsServiceId  │
└─────────────────────────┘     │         └───────────────────┘
         │                      │
         │                      └────────────────────┐
         │                                           │
         ▼                                           ▼
    ┌─────────────┐                      ┌──────────────────┐
    │ Customers   │                      │ ServiceVenue[]   │
    │ buy:        │                      │ - venueId        │
    │ 1. Node     │                      │ - status         │
    │ 2. Services │                      └──────────────────┘
    └─────────────┘
```

## Data Models

### Server
Represents a VenueChat node (Docker container, VM, etc.)

```javascript
{
  id: "uuid",
  nodeId: "node-prod-us-east-1",  // Unique identifier for this node
  name: "Production US-East",
  region: "us-east-1",
  status: "active",  // active, maintenance, inactive
  maxConcurrentUsers: 150,
  maxChunksPerMinute: 1200,
  maxActiveVenues: 40,
  services: [Service],  // Can host multiple services
  createdAt: "2026-04-26T...",
}
```

### Service
A billable offering running on a server. Can be:
- **REALTIME_NODE**: Adds translation/transcription capacity
- **VENUE_HOSTING**: Adds venues + management

```javascript
{
  id: "uuid",
  serverId: "uuid",  // Which server this runs on
  serviceType: "VENUE_HOSTING",  // or REALTIME_NODE
  status: "provisioned",  // provisioned, active, suspended, terminated
  
  // WHMCS integration
  billingReference: "whmcs:12345",
  whmcsServiceId: 12345,  // Links to WHMCS tblhosting.id
  
  metadata: {
    maxConcurrentUsers: 50,
    maxLanguages: 6,
    numberOfVenues: 3,
  },
  
  venues: [ServiceVenue],  // If VENUE_HOSTING
  usage: [ServiceUsage],  // Monthly usage records
}
```

### ServiceVenue
Links a venue to a service (for VENUE_HOSTING).

```javascript
{
  serviceId: "uuid",
  venueId: "my-cafe",
  status: "active",  // active, suspended, terminated
}
```

### ServiceUsage
Monthly usage metrics per service (for billing).

```javascript
{
  serviceId: "uuid",
  billingPeriodStart: "2026-04-01T00:00:00Z",
  billingPeriodEnd: "2026-05-01T00:00:00Z",
  
  secondsProcessed: 14400,
  chunksProcessed: 2400,
  concurrentPeak: 125,
  translationLanguages: 5,
  
  overageAmountUsd: 99.50,
  syncStatus: "exported",  // pending, exported, reconciled
  exportedAt: "2026-04-29T15:30:00Z",
}
```

## Service Provisioning Flow

### 1. Customer Orders in WHMCS

```
Customer → WHMCS Shop → Orders:
├─ VenueChat Node (infrastructure)
├─ VenueChat Realtime Service (add-on)
└─ VenueChat Venue Hosting (add-on)
```

### 2. WHMCS Triggers Hook

When service is activated:
```
WHMCS ServiceActivation Hook
  ↓
  POST /api/system/whmcs/provision-service
  {
    serverId: "uuid-of-available-server",
    serviceType: "VENUE_HOSTING",
    billingReference: "whmcs:12345",
    whmcsServiceId: 12345,
    venueIds: ["my-cafe"],
    metadata: { ... }
  }
```

### 3. VenueChat Creates Service

```
Backend:
  1. Find or create Server record
  2. Create Service record linked to Server
  3. Create ServiceVenue records (if VENUE_HOSTING)
  4. Return { ok: true, service: {...} }
```

### 4. WHMCS Stores Service ID

Hook stores `venuechatServiceId` in custom field for future reference:
```
WHMCS Custom Field "VenueChat Service ID" = "abc123def456"
```

## Usage & Billing Flow

### Hourly Sync (Cron)

```
SyncServiceUsageCron.php (runs every hour)
  ↓
  FOR each active VenueChat service in WHMCS:
    GET /api/system/whmcs/service/{venuechatServiceId}/usage
    ↓
    INSERT/UPDATE venuechat_service_usage table
    (local MySQL for invoice processing)
```

### Monthly Reconciliation

```
End of Month:
  WHMCS admin or cron:
    1. Query venuechat_service_usage for previous month
    2. Calculate overage charges
    3. Create invoice line items
    4. Mark ServiceUsage as "reconciled"
    5. POST /api/system/whmcs/... to confirm reconciliation
```

## Service Lifecycle

### Active Service
- ✅ Venues can stream and translate
- ✅ Usage is tracked and billed
- ✅ Service available for operations

### Suspended Service
- ❌ Streaming blocked or rate-limited
- ✅ Venues remain linked (can restore)
- ⏸️ Awaiting payment or manual action

### Terminated Service
- ❌ All venues unlinked
- ❌ No streaming possible
- 🗑️ Service record marked terminated

## Workflow: Adding Another Node

```
1. Provision infrastructure:
   - Create VM/container
   - Install VenueChat app
   - Set NODE_ID env var
   
2. Call provisioning endpoint:
   POST /api/system/whmcs/provision-server
   {
     nodeId: "node-prod-us-west-2",
     name: "Production US-West",
     region: "us-west-2",
     maxConcurrentUsers: 300
   }
   
3. Backend creates Server record
   
4. New WHMCS customers now auto-assigned to least-loaded server
```

## Workflow: Customer Upgrades Venue Count

```
Customer in WHMCS:
  Upgrades from 1 to 3 venues
  
WHMCS:
  Updates tblcustomfields value
  → Hook could trigger POST to update-service
  
VenueChat:
  Updates Service.metadata.numberOfVenues = 3
  
Next billing cycle:
  Usage billing reflects higher limits
```

## Key Features

✅ **Multi-Server Support**: One Service can run on any Server
✅ **Load Balancing**: Auto-assign services to least-loaded servers
✅ **Flexible Scaling**: Add nodes and services independently
✅ **Usage Tracking**: Monthly metrics per service
✅ **Suspend/Unsuspend**: Pause without deleting
✅ **Terminate Cleanly**: Unlink venues, preserve history
✅ **Audit Trail**: All changes in WhmcsSyncRecord
✅ **Idempotent**: Duplicate API calls are safe

## Example Queries (SQL)

### Services per Server
```sql
SELECT s.*, COUNT(sv.id) as venue_count
FROM service s
LEFT JOIN service_venue sv ON s.id = sv.serviceId
WHERE s.serverId = 'server-uuid'
GROUP BY s.id;
```

### Monthly Revenue
```sql
SELECT 
  DATE_TRUNC('month', su.billingPeriodStart) as month,
  SUM(su.overageAmountUsd) as total_overage
FROM service_usage su
WHERE su.syncStatus = 'reconciled'
GROUP BY month;
```

### Suspended Services Needing Follow-up
```sql
SELECT s.*, COUNT(sv.id) as venue_count
FROM service s
LEFT JOIN service_venue sv ON s.id = sv.serviceId
WHERE s.status = 'suspended'
AND s.updatedAt < NOW() - INTERVAL 7 days;
```

---

**Next**: See [SETUP_GUIDE.md](./SETUP_GUIDE.md) for detailed installation instructions.
