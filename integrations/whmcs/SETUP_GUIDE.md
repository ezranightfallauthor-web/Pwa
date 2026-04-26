# VenueChat WHMCS Server & Service Integration Guide

This guide walks you through configuring WHMCS to treat VenueChat nodes as servers with two types of billable services.

## Overview

**Goal:** Allow WHMCS customers to purchase and manage:
1. **VenueChat Nodes** - Infrastructure (compute resources)
2. **Services on Nodes** - REALTIME_NODE or VENUE_HOSTING (billable features)

**Result:** Seamless expansion through WHMCS, just like traditional dedicated/VPS servers.

---

## Step 1: Database Setup

### Migrate the database to add Server & Service models:

```bash
# From VenueChat directory
npx prisma migrate deploy
```

This creates:
- `Server` - Represents a VenueChat node
- `Service` - Represents a billable service (REALTIME_NODE or VENUE_HOSTING) on a server
- `ServiceVenue` - Links services to venues
- `VenueService` - Reverse link for venue → services
- `ServiceUsage` - Tracks usage metrics per billing period

---

## Step 2: Environment Configuration

### On VenueChat Server:

```bash
# .env
WHMCS_API_KEY=your-secret-key-here
```

Generate a strong random key:
```bash
openssl rand -hex 32
```

### On WHMCS Server:

```bash
# .env or wherever you store secrets
VENUECHAT_API_BASE=https://your-venuechat-api.com
VENUECHAT_WHMCS_KEY=your-secret-key-here  # Must match WHMCS_API_KEY
```

---

## Step 3: Create WHMCS Products

### Product 1: VenueChat Node (Base Infrastructure)

Go to **Setup → Products/Services**

1. Create new product group: `VenueChat`
2. Create product: **VenueChat Node**
   - Internal Name: `venuechat_node`
   - Module: None (Standalone)
   - Billing Cycle: Monthly
   - Setup Fee: $99/month
   - Renewal Price: $99/month

3. Add Configurable Options:
   - **Region** (Dropdown)
     - Options: `us-east-1`, `us-west-1`, `eu-west-1`, `ap-southeast-1`
   - **Max Concurrent Users** (Dropdown)
     - Options: 150, 300, 500
   - **Max Chunks/Min** (Dropdown)
     - Options: 1200, 2400, 4800

### Product 2: Realtime Node Service (Add-on)

1. Create product: **VenueChat Realtime Service**
   - Internal Name: `venuechat_realtime_service`
   - Module: None
   - Billing Cycle: Monthly
   - Renewal Price: $29/month
   - **Link to parent group:** VenueChat (as add-on)
   
### Product 3: Venue Hosting Service (Add-on)

1. Create product: **VenueChat Venue Hosting**
   - Internal Name: `venuechat_venue_hosting`
   - Module: None
   - Billing Cycle: Monthly
   - Renewal Price: $49/month
   - **Link to parent group:** VenueChat (as add-on)

2. Add Configurable Options:
   - **Number of Venues** (Dropdown)
     - Options: 1, 3, 5, 10
   - **Max Users per Venue** (Dropdown)
     - Options: 50, 100, 200
   - **Translation Languages** (Dropdown)
     - Options: 2, 6, 20

---

## Step 4: Install WHMCS Hooks

1. Copy hook files into your WHMCS hooks directory:

```bash
cp integrations/whmcs/hooks/*.php /path/to/whmcs/resources/hooks/
```

2. Create custom field for VenueChat Service ID mapping:

   Go to **Setup → Custom Fields**
   - Module: Hosting
   - Field Name: `VenueChat Service ID`
   - Field Type: Text (hidden from clients)
   - Store in database

   Note the field ID (e.g., 999) - you'll need it for the cron job.

---

## Step 5: Configure the Cron Job

### On WHMCS Server:

1. Update `SyncServiceUsageCron.php`:
   - Set database credentials (lines 17-18)
   - Set custom field ID for VenueChat Service ID (line 154)

2. Create MySQL table for usage snapshots:

```sql
CREATE TABLE `venuechat_service_usage` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `whmcs_service_id` INT NOT NULL,
  `venuechat_service_id` VARCHAR(255) NOT NULL,
  `seconds_processed` FLOAT DEFAULT 0,
  `concurrent_peak` INT DEFAULT 0,
  `translation_count` INT DEFAULT 0,
  `overage` FLOAT DEFAULT 0,
  `sync_date` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uc_service_id` (`whmcs_service_id`)
);
```

3. Schedule cron job (run every hour):

```bash
# Via crontab
0 * * * * /usr/bin/php /path/to/whmcs/cron/SyncServiceUsageCron.php >> /var/log/venuechat-sync.log 2>&1
```

Or use WHMCS built-in cron (Setup → Automation Settings):
- Create custom cron task pointing to `SyncServiceUsageCron.php`

---

## Step 6: Test the Integration

### 1. Verify API Key is Set:

```bash
curl -H "x-whmcs-key: your-secret-key" \
  https://your-venuechat-api.com/api/system/health
```

Expected: `{"ok": true, "service": "venuechat-api"}`

### 2. Test Server Provisioning:

```bash
curl -X POST \
  -H "x-whmcs-key: your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "nodeId": "node-test-1",
    "name": "Test Node",
    "region": "us-east-1",
    "maxConcurrentUsers": 150
  }' \
  https://your-venuechat-api.com/api/system/whmcs/provision-server
```

Expected: `{"ok": true, "server": {...}}`

### 3. Test Service Provisioning:

```bash
# Get server ID from previous response, then:
curl -X POST \
  -H "x-whmcs-key: your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "serverId": "server-uuid-from-step-2",
    "serviceType": "VENUE_HOSTING",
    "billingReference": "a12345",
    "whmcsServiceId": "12345",
    "venueIds": ["my-cafe"]
  }' \
  https://your-venuechat-api.com/api/system/whmcs/provision-service
```

Expected: `{"ok": true, "service": {...}}`

### 4. Test Usage Export:

```bash
curl -H "x-whmcs-key: your-secret-key" \
  https://your-venuechat-api.com/api/system/whmcs/service/{serviceId}/usage
```

Expected: Usage metrics for billing

---

## Step 7: Production Deployment

### Before Going Live:

1. **Security Hardening**
   - Rotate `WHMCS_API_KEY` to a strong random value
   - Restrict WHMCS server IP in firewall
   - Use HTTPS only (enforce via reverse proxy)
   - Add rate limiting on provisioning endpoints

2. **Monitoring**
   - Monitor `WhmcsSyncRecord` table for failed syncs
   - Set up alerts for failed cron jobs
   - Track API response times

3. **Backup Strategy**
   - Back up `Server` and `Service` tables daily
   - Test recovery procedures

4. **DNS & Load Balancing**
   - If running multiple VenueChat API nodes, use load balancer
   - Point `VENUECHAT_API_BASE` to load balancer URL

### Server Assignment Logic

The `SyncServiceUsageCron.php` includes a basic server selection algorithm. For production, implement:

```php
// Smart server selection based on:
// 1. Server capacity (available slots)
// 2. Geographic region (match customer preference)
// 3. Current load (CPU, memory, connections)
// 4. Service type affinity (realtime vs venue)
```

---

## Step 8: Operational Procedures

### Creating a New VenueChat Node

1. **Infrastructure:**
   - Provision VM/container (e.g., AWS EC2, DigitalOcean)
   - Install VenueChat app
   - Set `NODE_ID` environment variable
   - Start services

2. **WHMCS:**
   - Create VenueChat Node order for customer
   - Auto-triggers provisioning hook
   - Backend calls `/api/system/whmcs/provision-server`

3. **DNS:**
   - Add node to load balancer pool
   - Update Socket.IO connection string in PWA

### Scaling a Service

1. Customer upgrades from 1 to 3 venues in WHMCS
2. Hook updates service metadata
3. On next usage sync, billing reflects new tier

### Suspending a Service

1. WHMCS payment fails or manual suspension
2. Hook calls `/api/system/whmcs/service/:id/suspend`
3. Service marked as "suspended" in VenueChat
4. Venue sessions can still access but with rate limits

### Terminating a Service

1. Customer cancels or service expires
2. Hook calls `/api/system/whmcs/service/:id/terminate`
3. Service venues are unlinked
4. Service deleted from VenueChat

---

## Troubleshooting

### Services Not Provisioning

1. Check API key: `echo $VENUECHAT_WHMCS_KEY`
2. Check network: `curl -v -H "x-whmcs-key: $key" $VENUECHAT_API_BASE/api/system/health`
3. Review logs:
   - VenueChat: `server.log`
   - WHMCS: `tblmodulelog` or hook log

### Usage Sync Failing

1. Verify cron is running: `ps aux | grep cron`
2. Check database connection in `SyncServiceUsageCron.php`
3. Verify custom field ID in `getVenuechatServiceId()` matches WHMCS setup
4. Test curl directly:
   ```bash
   curl -H "x-whmcs-key: $key" \
     https://api.venuechat.com/api/system/whmcs/service/{id}/usage
   ```

### Webhook Delays

The provisioning hook is synchronous. For large deployments, consider:
- Async queue (Redis, RabbitMQ)
- Webhook retry logic in VenueChat
- Polling-based service discovery

---

## API Reference Quick Start

| Action | Endpoint | Method |
|--------|----------|--------|
| Register Node | `/api/system/whmcs/provision-server` | POST |
| Provision Service | `/api/system/whmcs/provision-service` | POST |
| List Servers | `/api/system/whmcs/servers` | GET |
| Suspend Service | `/api/system/whmcs/service/:id/suspend` | POST |
| Unsuspend Service | `/api/system/whmcs/service/:id/unsuspend` | POST |
| Terminate Service | `/api/system/whmcs/service/:id/terminate` | POST |
| Get Service Usage | `/api/system/whmcs/service/:id/usage` | GET |

All endpoints require `x-whmcs-key` header.

---

## Next Steps

1. ✅ Test with a single node and service
2. ✅ Train support team on new billing model
3. ✅ Set up monitoring/alerting
4. ✅ Create customer documentation
5. ✅ Plan for multi-node load balancing
6. ✅ Consider marketplace integrations (ServerPilot, Cloudflare API, etc.)
