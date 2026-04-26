# VenueChat PWA + Node.js Realtime API

VenueChat now includes both:

- **PWA front end** with screens for splash, auth, language onboarding, venues, room, conversation, and settings.
- UI uses Bootstrap components + small CSS animations so realtime translations animate in as they appear.
- Includes QR join flow (`venue:<venueId>`) and Screen Wake Lock support so the PWA can stay active while the phone is put down in-room/conversation.
- Speaker room and conversation now share the exact same mic/manual transcript input model; billing for conversation is per participant and Socket.IO rooms follow `room`, `room:en`, `room:fr` style language channels.
- Users receive language packs based on their primary language (`/api/auth/language-pack`) and can review that pack in Settings.
- Settings includes a user-friendly UI language preference: match app language to primary language, or lock app navigation language to English.
- Built-in PWA install analytics tracks total installs plus top UI languages and countries (`/api/analytics/install-summary`).
- Programmatic node-scaling recommendation endpoint (`/api/system/scale/recommendation`) estimates when to add server nodes based on concurrent users, active venues, and chunks/minute.
- Added a System Admin panel in the PWA to view install metrics and node-scaling recommendation in one screen.
- Room rendering uses a live-caption layout similar to Chillexion Live Translate.
- **Node.js backend** with REST + Socket.IO realtime translation/transcription endpoints.
- Realtime session routing is server-driven (`session:configure`), so clients only send chunk data and can reconnect flexibly across nodes.
- Persistence now uses **Prisma + PostgreSQL** (ready for AWS RDS / Cloud SQL / AlloyDB style deployments).
- JWT-based auth sessions are stored in Prisma so users can review active login devices and remotely log out unrecognized sessions.
- Users have roles: `admin`, `venue_host`, `user` (default). System-level analytics/scale endpoints require `admin` or `venue_host`.
- Venue access now requires authorization: users request access, and `admin`/`venue_host` can approve requests.
- Added a Venue Panel so users can belong to multiple venues and manage join/leave membership from Settings.
- Includes WHMCS-ready integration endpoints for automated user provisioning and overage export.
- Billing stack now includes ledger events, monthly periodization, idempotent chunk billing keys, and reconciliation tracking.
- Added WHMCS-side automation starter files under `integrations/whmcs/` (hooks + cron patterns).

## Front-end onboarding flow

1. Splash
2. Register/Login
3. Select all languages a user knows
4. Rank selected languages by fluency
5. Enter venues/room/conversation experience

At the end of a venue session, click **End Session** to reveal a **Download Session** button for transcript export.

## Backend behavior

- Translation package limits are based on **number of target languages**.
- Usage is polled via `GET /api/usage/:userId` and `GET /api/usage/venue/:venueId`.
- Venue realtime stats endpoint `GET /api/venues/:venueId/stats` reports connected users, connected language mix, translated language count, and upgrade suggestion when active translation languages exceed plan limits.
- Session timeline endpoint `GET /api/venues/:venueId/stats/session` exposes session start from first chunk, host stop timestamps, and auto-stop after 3 minutes of no chunks.
- Venue streaming is billed to the venue by default; conversation mode bills each participant.
- Realtime Socket.IO nodes can scale horizontally if all nodes point to the same Postgres database.

## Run locally

```bash
cp .env.example .env
# set JWT_SECRET in .env
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

Open <http://localhost:3000>.

TV mode:
`http://localhost:3000/?tv=1&venue=bluebird`

## API quick reference

System
- `GET /api/system/health`
- `GET /api/system/plans`
- `GET /api/system/scale/recommendation` (admin/venue_host)
- `POST /api/system/install`
- `GET /api/system/install-summary` (admin/venue_host)
- `POST /api/system/whmcs/provision-user` (requires `x-whmcs-key`)
- `GET /api/system/whmcs/overage-report` (requires `x-whmcs-key`)
- `GET /api/system/billing/periods` (admin/venue_host)
- `POST /api/system/billing/periods/:periodId/reconcile` (admin/venue_host)

User
- `POST /api/user/auth/login`
- `GET /api/user/auth/sessions`
- `POST /api/user/auth/sessions/:sessionId/logout`
- `POST /api/user/language-pack`
- `GET /api/user/language-pack`
- `GET /api/user/venues`
- `POST /api/user/venues/:venueId/join`
- `POST /api/user/venues/:venueId/leave`
- `POST /api/user/:userId/plan`
- `GET /api/user/:userId/usage`

Venue
- `GET /api/venue/:venueId/stats`
- `GET /api/venue/:venueId/stats/session`
- `GET /api/venue/:venueId/usage`
- `GET /api/venue/:venueId/access/me`
- `POST /api/venue/:venueId/access/request`
- `GET /api/venue/:venueId/access/pending` (admin/venue_host)
- `POST /api/venue/:venueId/access/:userId/approve` (admin/venue_host)

Audio
- `POST /api/audio/chunk`

Legacy routes from earlier builds are still available for backward compatibility.
