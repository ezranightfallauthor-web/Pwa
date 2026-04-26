# Integration: Adding WHMCS Handlers to server.js

This guide shows how to integrate the new WHMCS server & service handlers into your existing `server.js`.

## Step 1: Import the Handlers

At the top of `server.js` (after other imports), add:

```javascript
import {
  whmcsProvisionServerHandler,
  whmcsListServersHandler,
  whmcsProvisionServiceHandler,
  whmcsGetServiceHandler,
  whmc sSuspendServiceHandler,
  whmcsUnsuspendServiceHandler,
  whmcsTerminateServiceHandler,
  whmcsServiceUsageHandler,
} from './api/whmcs-handlers.js';
```

## Step 2: Register Routes

Add these routes to your Express app. Insert them **after line 571** (after the existing WHMCS billing endpoints):

```javascript
// ============================================================================
// WHMCS Server & Service Management Routes
// ============================================================================

// Server management
app.post('/api/system/whmcs/provision-server', whmcsMiddleware, whmcsProvisionServerHandler);
app.get('/api/system/whmcs/servers', whmcsMiddleware, whmcsListServersHandler);

// Service management (provision, suspend, terminate)
app.post('/api/system/whmcs/provision-service', whmcsMiddleware, whmcsProvisionServiceHandler);
app.get('/api/system/whmcs/service/:serviceId', whmcsMiddleware, whmcsGetServiceHandler);
app.post('/api/system/whmcs/service/:serviceId/suspend', whmcsMiddleware, whmc sSuspendServiceHandler);
app.post('/api/system/whmcs/service/:serviceId/unsuspend', whmcsMiddleware, whmcsUnsuspendServiceHandler);
app.post('/api/system/whmcs/service/:serviceId/terminate', whmcsMiddleware, whmcsTerminateServiceHandler);

// Service usage export (for WHMCS billing)
app.get('/api/system/whmcs/service/:serviceId/usage', whmcsMiddleware, whmcsServiceUsageHandler);
```

## Step 3: Update server.js Fully

Here's the complete section to add (find line 571, after `reconcileBillingPeriodHandler`):

```javascript
const reconcileBillingPeriodHandler = async (req, res) => {
  const { periodId } = req.params;
  const { externalRef = null, payload = null } = req.body || {};
  const period = await prisma.billingPeriod.findUnique({ where: { id: periodId } });
  if (!period) return res.status(404).json({ error: 'Period not found.' });
  const updated = await prisma.billingPeriod.update({
    where: { id: periodId },
    data: { status: 'reconciled', reconciledAt: new Date() },
  });
  await prisma.whmcsSyncRecord.create({
    data: {
      id: crypto.randomUUID(),
      periodId,
      direction: 'export',
      status: 'success',
      payload: payload ? JSON.stringify(payload).slice(0, 3000) : null,
      externalRef: externalRef ? String(externalRef).slice(0, 180) : null,
    },
  });
  res.json({ period: updated });
};

// ============================================================================
// WHMCS Server & Service Handlers (import at top of file)
// ============================================================================

import {
  whmcsProvisionServerHandler,
  whmcsListServersHandler,
  whmcsProvisionServiceHandler,
  whmcsGetServiceHandler,
  whmc sSuspendServiceHandler,
  whmcsUnsuspendServiceHandler,
  whmcsTerminateServiceHandler,
  whmcsServiceUsageHandler,
} from './api/whmcs-handlers.js';
```

## API Endpoints Now Available

```bash
# Register a new VenueChat node
POST /api/system/whmcs/provision-server
{
  "nodeId": "node-us-east-1-01",
  "name": "US East Node 1",
  "region": "us-east-1",
  "maxConcurrentUsers": 150,
  "maxChunksPerMinute": 1200,
  "maxActiveVenues": 40
}

# List all servers and their services
GET /api/system/whmcs/servers

# Provision a service on a server
POST /api/system/whmcs/provision-service
{
  "serverId": "server-uuid",
  "serviceType": "VENUE_HOSTING",    // or REALTIME_NODE
  "billingReference": "a12345",
  "whmcsServiceId": 12345,
  "externalRef": "vch-12345",
  "venueIds": ["my-cafe", "my-bar"],
  "metadata": { "maxLanguages": 6, "maxUsers": 100 }
}

# Get service details
GET /api/system/whmcs/service/:serviceId

# Suspend/Unsuspend/Terminate
POST /api/system/whmcs/service/:serviceId/suspend
POST /api/system/whmcs/service/:serviceId/unsuspend
POST /api/system/whmcs/service/:serviceId/terminate

# Export usage for billing
GET /api/system/whmcs/service/:serviceId/usage?periodStart=2026-04-01&periodEnd=2026-04-30
```

## Testing

```bash
# 1. Start your server
npm run dev

# 2. Provision a server
curl -X POST \
  -H "x-whmcs-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "nodeId": "test-node-1",
    "name": "Test Node",
    "region": "us-east-1"
  }' \
  http://localhost:3000/api/system/whmcs/provision-server

# 3. Get the server ID from response, then provision a service
curl -X POST \
  -H "x-whmcs-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "serverId": "PASTE_SERVER_ID_HERE",
    "serviceType": "VENUE_HOSTING",
    "billingReference": "w12345_6789",
    "whmcsServiceId": 12345,
    "venueIds": ["bluebird", "arcade"]
  }' \
  http://localhost:3000/api/system/whmcs/provision-service
```

## Database Migration

Before deploying, run the migration:

```bash
npx prisma migrate deploy
npx prisma generate
```

## What's Created

✅ `Server` model - Represents VenueChat nodes
✅ `Service` model - Billable services (REALTIME_NODE or VENUE_HOSTING)
✅ `ServiceVenue` - Links venues to VENUE_HOSTING services
✅ `ServiceUsage` - Tracks usage per billing period
✅ 8 new API endpoints - Full service lifecycle management
✅ WHMCS integration - Provisioning hooks ready for WHMCS

## Next: WHMCS Side Setup

See `integrations/whmcs/SETUP_GUIDE.md` for:
1. Creating WHMCS products
2. Installing hooks
3. Setting up the cron job
4. Testing the integration
