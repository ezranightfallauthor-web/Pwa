# WHMCS Automation (Hooks + Cron + Module Pattern)

This folder contains starter automation examples for integrating WHMCS with VenueChat's system endpoints.

## Prerequisites

- VenueChat API reachable from WHMCS host.
- `WHMCS_API_KEY` configured in VenueChat `.env`.
- Matching key configured on WHMCS side as an environment variable (`VENUECHAT_WHMCs_KEY` in examples).

## Files

- `hooks/ProvisionUserHook.php`
  - Hook pattern to provision a user from WHMCS lifecycle events.
  - Calls: `POST /api/system/whmcs/provision-user`

- `cron/SyncOverages.php`
  - Cron pattern that pulls overage data from VenueChat.
  - Calls: `GET /api/system/whmcs/overage-report`
  - Writes a local JSON output for further invoice module processing.

## Suggested deployment flow

1. Copy hook file into your WHMCS hooks directory.
2. Set env vars:
   - `VENUECHAT_API_BASE`
   - `VENUECHAT_WHMCs_KEY`
3. Register cron:
   - every hour for overage sync (or your billing cadence).
4. Extend the cron script to map overage rows into WHMCS invoice line items.

## Notes

- The examples are intentionally conservative and include idempotent external IDs where possible.
- You should add production controls:
  - retry + backoff
  - logging/alerting
  - signature validation and allowlists
  - dead-letter handling for failed sync cycles
