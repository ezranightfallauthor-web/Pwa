const STORAGE_KEY = 'venuechat.state.v3';
const INSTALL_ID_KEY = 'venuechat.install.id';
const fluencyScale = ['Native', 'Advanced', 'Intermediate', 'Beginner'];
const languageCatalog = ['English', 'Spanish', 'French', 'German', 'Japanese', 'Mandarin', 'Arabic', 'Portuguese'];

const screens = {
  splash: document.querySelector('#screen-splash'),
  auth: document.querySelector('#screen-auth'),
  languageSelect: document.querySelector('#screen-language-select'),
  languageFluency: document.querySelector('#screen-language-fluency'),
  venues: document.querySelector('#screen-venues'),
  room: document.querySelector('#screen-room'),
  conversation: document.querySelector('#screen-conversation'),
  tv: document.querySelector('#screen-tv'),
  settings: document.querySelector('#screen-settings'),
  admin: document.querySelector('#screen-admin'),
};

const authForm = document.querySelector('#auth-form');
const authStatus = document.querySelector('#auth-status');
const nav = document.querySelector('#main-nav');
const languageSelectForm = document.querySelector('#language-select-form');
const languageFluencyForm = document.querySelector('#language-fluency-form');
const venuesList = document.querySelector('#venues-list');
const venueAccessStatus = document.querySelector('#venue-access-status');
const scanQrButton = document.querySelector('#scan-qr');
const wakeStatus = document.querySelector('#wake-status');
const qrVideo = document.querySelector('#qr-video');
const qrFallback = document.querySelector('#qr-fallback');
const applyQrFallback = document.querySelector('#apply-qr-fallback');
const roomTitle = document.querySelector('#room-title');
const roomDescription = document.querySelector('#room-description');
const roomLanguageChips = document.querySelector('#room-language-chips');
const roomCaptions = document.querySelector('#room-captions');
const roomLiveStatus = document.querySelector('#room-live-status');
const exportCaptionsButton = document.querySelector('#export-captions');
const endSessionButton = document.querySelector('#end-session');
const speakerControls = document.querySelector('#speaker-controls');
const conversationControls = document.querySelector('#conversation-controls');
const messageList = document.querySelector('#message-list');
const tvVenueLabel = document.querySelector('#tv-venue-label');
const tvTranscript = document.querySelector('#tv-transcript');
const notificationToggle = document.querySelector('#setting-notifications');
const darkModeToggle = document.querySelector('#setting-darkmode');
const matchUiLanguageToggle = document.querySelector('#setting-match-ui-language');
const uiLanguageStatus = document.querySelector('#ui-language-status');
const uiLanguageOnboardingNote = document.querySelector('#ui-language-onboarding-note');
const sessionsList = document.querySelector('#sessions-list');
const languagePackCard = document.querySelector('#language-pack-card');
const installAnalyticsCard = document.querySelector('#install-analytics-card');
const venuePanelList = document.querySelector('#venue-panel-list');
const adminOverviewCards = document.querySelector('#admin-overview-cards');
const pendingAccessList = document.querySelector('#pending-access-list');
const billingPeriodList = document.querySelector('#billing-period-list');
const openAdminPanelButton = document.querySelector('#open-admin-panel');
const navAdminButton = document.querySelector('#nav-admin');

const venues = [
  { id: 'bluebird', name: 'Bluebird Café', room: 'Coffee Fans', members: 12 },
  { id: 'arcade', name: 'Retro Arcade', room: 'Game Night', members: 28 },
  { id: 'skyline', name: 'Skyline Rooftop', room: 'Sunset Lounge', members: 17 },
];

const defaultState = {
  user: null,
  onboardingComplete: false,
  knownLanguages: [],
  joinedVenueIds: [],
  fluencyByLanguage: {},
  recentVenueId: venues[0].id,
  settings: { notifications: false, darkmode: false, matchUiLanguage: true },
  liveCaptions: [],
  conversationMessages: [{ id: crypto.randomUUID(), from: 'VenueBot', text: 'Conversation started.' }],
  sessionEnded: false,
  authToken: null,
  currentSessionId: null,
  languagePack: null,
};

const readState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { ...defaultState, ...raw, settings: { ...defaultState.settings, ...(raw.settings ?? {}) } };
  } catch {
    return defaultState;
  }
};

let state = readState();
let realtimeSocket = null;
let micIntervals = {};
let wakeLockSentinel = null;
let qrStream = null;

const saveState = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
const canAccessAdminPanel = () => ['admin', 'venue_host'].includes(state.user?.role || 'user');
const memberVenues = () => venues.filter((entry) => state.joinedVenueIds.includes(entry.id));
const activeVenue = () => memberVenues().find((entry) => entry.id === state.recentVenueId) ?? memberVenues()[0] ?? venues[0];
const languageCode = (name) => ({ English: 'en', Spanish: 'es', French: 'fr', German: 'de', Japanese: 'ja', Mandarin: 'zh', Arabic: 'ar', Portuguese: 'pt' }[name] ?? 'en');
const baseSocketRoom = 'room';
const primaryLanguageCode = () => languageCode(state.knownLanguages[0] ?? 'English');
const resolvedUiLanguage = () => (state.settings.matchUiLanguage ? primaryLanguageCode() : 'en');

const query = new URLSearchParams(location.search);
const isTvMode = query.get('tv') === '1';
const tvVenueId = query.get('venue') || venues[0].id;



const requestWakeLock = async () => {
  if (!('wakeLock' in navigator) || wakeLockSentinel) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeStatus.textContent = 'Wake lock: on';
    wakeStatus.className = 'badge text-bg-success';
    wakeLockSentinel.addEventListener('release', () => {
      wakeLockSentinel = null;
      wakeStatus.textContent = 'Wake lock: off';
      wakeStatus.className = 'badge text-bg-secondary';
    });
  } catch {
    wakeStatus.textContent = 'Wake lock unavailable';
    wakeStatus.className = 'badge text-bg-warning';
  }
};

const releaseWakeLock = async () => {
  if (!wakeLockSentinel) return;
  await wakeLockSentinel.release();
};

const joinVenueById = (venueId) => {
  const venue = venues.find((v) => v.id === venueId);
  if (!venue) return false;
  state.recentVenueId = venue.id;
  state.sessionEnded = false;
  saveState();
  showScreen('room');
  requestWakeLock();
  return true;
};
const requestVenueEntry = async (venueId) => {
  if (!state.authToken || !state.user) return false;
  const headers = { Authorization: `Bearer ${state.authToken}` };
  const accessResponse = await fetch(`/api/venue/${venueId}/access/me`, { headers });
  if (!accessResponse.ok) return false;
  const access = await accessResponse.json();
  if (access.status === 'approved') return true;

  const requestResponse = await fetch(`/api/venue/${venueId}/access/request`, { method: 'POST', headers });
  if (!requestResponse.ok) return false;
  const requested = await requestResponse.json();
  if (requested.access?.status === 'approved') return true;
  venueAccessStatus.textContent = 'Access requested. Please wait for venue host/admin approval.';
  return false;
};

const refreshVenueMemberships = async () => {
  if (!state.authToken || !state.user) return;
  try {
    const response = await fetch('/api/user/venues', { headers: { Authorization: `Bearer ${state.authToken}` } });
    if (!response.ok) return;
    const payload = await response.json();
    state.joinedVenueIds = payload.venues.filter((entry) => entry.joined).map((entry) => entry.id);
    if (state.joinedVenueIds.length && !state.joinedVenueIds.includes(state.recentVenueId)) state.recentVenueId = state.joinedVenueIds[0];
    saveState();
  } catch {
    // keep local fallback
  }
};

const parseQrPayload = (payload) => {
  const text = String(payload || '').trim();
  if (!text.startsWith('venue:')) return null;
  return text.split(':')[1];
};

const stopQrScan = () => {
  if (qrStream) {
    qrStream.getTracks().forEach((track) => track.stop());
    qrStream = null;
  }
};

const startQrScan = async () => {
  if (!('mediaDevices' in navigator)) return;
  try {
    qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    qrVideo.srcObject = qrStream;

    if ('BarcodeDetector' in window) {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const tick = async () => {
        if (!qrStream) return;
        const results = await detector.detect(qrVideo);
        if (results.length) {
          const venueId = parseQrPayload(results[0].rawValue);
          const allowed = venueId ? await requestVenueEntry(venueId) : false;
          if (venueId && allowed && joinVenueById(venueId)) {
            bootstrap.Modal.getOrCreateInstance(document.querySelector('#qrModal')).hide();
            stopQrScan();
            return;
          }
        }
        requestAnimationFrame(tick);
      };
      tick();
    }
  } catch {
    // fallback input still available
  }
};

const connectRealtime = () => {
  if (realtimeSocket || !state.user || typeof window.io !== 'function') return;
  const sourceLanguage = state.knownLanguages[0] ?? 'English';
  const targetLanguages = state.knownLanguages.slice(1, 4);

  realtimeSocket = window.io({
    auth: { token: state.authToken },
    query: {
      sourceLanguage,
      targets: targetLanguages.join(','),
    },
  });

  realtimeSocket.on('translation:ready', () => {
    roomLiveStatus.textContent = 'Live';
  });

  realtimeSocket.on('translation:update', (data) => {
    state.liveCaptions.push({ id: crypto.randomUUID(), language: data.language, text: data.text, room: data.room, animated: true });
    if (data.mode === 'conversation') {
      state.conversationMessages.push({ id: crypto.randomUUID(), from: data.language, text: data.text, animated: true });
      renderConversationMessages();
    }
    renderRoom();
    if (isTvMode) renderTvTranscript();
    saveState();
  });

  realtimeSocket.on('translation:error', (data) => {
    roomLiveStatus.textContent = `Error: ${data.error}`;
  });

  realtimeSocket.on('disconnect', () => {
    roomLiveStatus.textContent = 'Disconnected';
    realtimeSocket = null;
  });
};


const configureRealtimeSession = (mode) => {
  connectRealtime();
  if (!realtimeSocket) return;
  realtimeSocket.emit('session:configure', {
    venueId: activeVenue().id,
    mode,
    preferredLanguage: primaryLanguageCode(),
  });
};

const buildStreamControls = (container, modeLabel) => {
  container.innerHTML = '';
  container.innerHTML = `
    <div class="stream-controls">
      <div class="button-row">
        <button type="button" data-action="start">Start Mic</button>
        <button type="button" data-action="stop" class="ghost">Stop Mic</button>
      </div>
      <label>Manual Transcript (optional)</label>
      <div class="task-input-row">
        <input data-field="manual" placeholder="Type transcript..." />
        <button type="button" data-action="send">Send ${modeLabel} Transcript</button>
      </div>
    </div>
  `;

  const input = container.querySelector('[data-field="manual"]');

  const emitChunk = (text, synthetic = false) => {
    connectRealtime();
    if (!realtimeSocket) return;
    realtimeSocket.emit('audio:chunk', {
      chunkId: crypto.randomUUID(),
      durationMs: Math.max(900, text.length * 40),
      transcriptHint: text,
      synthetic,
    });

    if (modeLabel === 'Conversation') {
      state.conversationMessages.push({ id: crypto.randomUUID(), from: 'You', text, animated: true });
      renderConversationMessages();
      saveState();
    }
  };

  container.querySelector('[data-action="send"]').addEventListener('click', () => {
    const value = input.value.trim();
    if (!value) return;
    emitChunk(value, false);
    input.value = '';
  });

  container.querySelector('[data-action="start"]').addEventListener('click', () => {
    if (micIntervals[modeLabel]) return;
    micIntervals[modeLabel] = setInterval(() => {
      emitChunk(`${modeLabel} live audio sample from ${state.user?.email ?? 'guest'}`, true);
    }, 2600);
  });

  container.querySelector('[data-action="stop"]').addEventListener('click', () => {
    if (!micIntervals[modeLabel]) return;
    clearInterval(micIntervals[modeLabel]);
    delete micIntervals[modeLabel];
  });
};

const renderLanguageSelector = () => {
  languageSelectForm.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'stack';
  languageCatalog.forEach((language) => {
    const label = document.createElement('label');
    label.className = 'switch-row';
    label.innerHTML = `<span>${language}</span><input type="checkbox" name="language" value="${language}" ${state.knownLanguages.includes(language) ? 'checked' : ''}/>`;
    list.append(label);
  });
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Continue';
  languageSelectForm.append(list, submit);
};

const renderFluencyEditor = () => {
  languageFluencyForm.innerHTML = '';
  const pendingPrimaryLanguage = state.knownLanguages[0] ?? 'English';
  uiLanguageOnboardingNote.textContent = `Your app language will follow ${pendingPrimaryLanguage} by default. You can lock the app to English anytime in Settings.`;
  state.knownLanguages.forEach((language) => {
    const row = document.createElement('label');
    row.className = 'row-between';
    row.innerHTML = `<span>${language}</span><select name="fluency-${language}">${fluencyScale
      .map((option) => `<option value="${option}" ${state.fluencyByLanguage[language] === option ? 'selected' : ''}>${option}</option>`)
      .join('')}</select>`;
    languageFluencyForm.append(row);
  });
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Finish Setup';
  languageFluencyForm.append(submit);
};

const renderVenues = async () => {
  venuesList.innerHTML = '';
  venueAccessStatus.textContent = '';
  const statsByVenue = await Promise.all(
    venues.map(async (venue) => {
      try {
        const [statsResponse, sessionResponse] = await Promise.all([
          fetch(`/api/venue/${venue.id}/stats`),
          fetch(`/api/venue/${venue.id}/stats/session`),
        ]);
        if (!statsResponse.ok) return [venue.id, null];
        const stats = await statsResponse.json();
        const sessionPayload = sessionResponse.ok ? await sessionResponse.json() : null;
        return [venue.id, { ...stats, session: sessionPayload?.session ?? null }];
      } catch {
        return [venue.id, null];
      }
    }),
  );
  const statsMap = Object.fromEntries(statsByVenue);
  if (!state.joinedVenueIds.length) {
    venuesList.innerHTML = '<li class="card-item">You are not a member of any venues yet. Use Venue Panel in Settings to join one.</li>';
    return;
  }

  venues.forEach((venue) => {
    if (!state.joinedVenueIds.includes(venue.id)) return;
    const stats = statsMap[venue.id];
    const item = document.createElement('li');
    item.className = 'card-item';
    const people = stats?.connectedPeople ?? 0;
    const langs = stats?.translatedLanguageCount ?? 0;
    const warning = stats?.shouldUpsell ? `<em class="text-warning">${stats.suggestion}</em>` : '';
    const sessionState = stats?.session ? (stats.session.stoppedAt ? `Last session ended ${new Date(stats.session.stoppedAt).toLocaleTimeString()}` : `Session started ${new Date(stats.session.startedAt).toLocaleTimeString()}`) : 'No session yet';
    item.innerHTML = `<button class="list-button" type="button"><strong>${venue.name}</strong><span>${venue.room} · ${people} connected · ${langs} translated languages</span><small>${sessionState}</small>${warning}</button>`;
    item.querySelector('button').addEventListener('click', async () => {
      const allowed = await requestVenueEntry(venue.id);
      if (!allowed) return;
      state.recentVenueId = venue.id;
      state.sessionEnded = false;
      saveState();
      requestWakeLock();
      if (realtimeSocket) {
        realtimeSocket.disconnect();
        realtimeSocket = null;
      }
      showScreen('room');
    });
    venuesList.append(item);
  });
};

const renderRoom = () => {
  const venue = activeVenue();
  roomTitle.textContent = `${venue.name} · Speaker Room`;
  roomDescription.textContent = `Speaker + conversation share identical inputs and bill participants per conversation usage. Language rooms follow room:<venueId> and room:<venueId>:<lang>.`;

  exportCaptionsButton.classList.toggle('d-none', !state.sessionEnded);
  roomLanguageChips.innerHTML = '';
  state.knownLanguages.forEach((language, index) => {
    const chip = document.createElement('span');
    chip.className = 'lang-chip';
    chip.textContent = `${index === 0 ? 'Primary' : 'Also'}: ${language} (${state.fluencyByLanguage[language] ?? 'Intermediate'})`;
    roomLanguageChips.append(chip);
  });

  roomCaptions.innerHTML = '';
  const latest = state.liveCaptions.filter((entry) => entry.mode === 'speaker').slice(-8);
  if (!latest.length) {
    roomCaptions.innerHTML = '<li class="card-item">Waiting for speaker captions…</li>';
  } else {
    latest.forEach((caption) => {
      const item = document.createElement('li');
      item.className = `card-item ${caption.animated ? 'fade-in' : ''}`;
      item.innerHTML = `<strong>${caption.language}</strong><p>${caption.text}</p>`;
      roomCaptions.append(item);
    });
  }

  state.liveCaptions.forEach((entry) => {
    entry.animated = false;
  });
};

const renderConversationMessages = () => {
  messageList.innerHTML = '';
  state.conversationMessages.slice(-30).forEach((message) => {
    const item = document.createElement('li');
    item.className = 'card-item';
    item.innerHTML = `<strong>${message.from}</strong><p>${message.text}</p>`;
    messageList.append(item);
  });

  state.conversationMessages.forEach((entry) => {
    entry.animated = false;
  });
};


const renderTvTranscript = () => {
  tvVenueLabel.textContent = activeVenue().name;
  tvTranscript.innerHTML = '';
  state.liveCaptions.slice(-60).forEach((caption) => {
    const item = document.createElement('li');
    item.className = 'card-item fade-in';
    item.innerHTML = `<strong>${caption.language}</strong><p>${caption.text}</p>`;
    tvTranscript.append(item);
  });
};



const syncLanguagePack = async () => {
  if (!state.authToken || !state.user || !state.knownLanguages.length) return;
  const primaryLanguage = primaryLanguageCode();
  const response = await fetch('/api/user/language-pack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.authToken}` },
    body: JSON.stringify({ primaryLanguage }),
  });
  if (!response.ok) return;
  state.languagePack = await response.json();
  saveState();
};

const renderLanguagePack = async () => {
  if (!state.authToken || !state.user) return;
  if (!state.languagePack) {
    const response = await fetch('/api/user/language-pack', { headers: { Authorization: `Bearer ${state.authToken}` } });
    if (response.ok) state.languagePack = await response.json();
  }
  if (!state.languagePack) return;
  languagePackCard.innerHTML = `<strong>${state.languagePack.packName}</strong><p>Primary: ${state.languagePack.primaryLanguage}</p><p>Includes: ${state.languagePack.includes.join(', ')}</p>`;
};

const renderInstallAnalytics = async () => {
  if (!state.authToken) return;
  try {
    const response = await fetch('/api/system/install-summary', { headers: { Authorization: `Bearer ${state.authToken}` } });
    if (response.status === 403) {
      installAnalyticsCard.innerHTML = '<strong>PWA Reach</strong><p>Available for admin and venue host roles.</p>';
      return;
    }
    if (!response.ok) return;
    const summary = await response.json();
    const topLanguages = summary.byLanguage?.slice(0, 5).map((entry) => `${entry.language} (${entry.installs})`).join(', ') || '—';
    const topCountries = summary.byCountry?.slice(0, 5).map((entry) => `${entry.country.toUpperCase()} (${entry.installs})`).join(', ') || '—';
    installAnalyticsCard.innerHTML = `<strong>Total installs: ${summary.totalInstalls}</strong><p>Top UI languages: ${topLanguages}</p><p>Top countries: ${topCountries}</p>`;
  } catch {
    installAnalyticsCard.innerHTML = '<strong>PWA reach unavailable</strong><p>Could not load install analytics right now.</p>';
  }
};

const reportInstallAnalytics = async () => {
  const installId = localStorage.getItem(INSTALL_ID_KEY) || crypto.randomUUID();
  if (!localStorage.getItem(INSTALL_ID_KEY)) localStorage.setItem(INSTALL_ID_KEY, installId);
  try {
    const uiLanguage = (navigator.languages?.[0] || navigator.language || 'en').toLowerCase().split('-')[0];
    const primaryLanguage = languageCode(state.knownLanguages[0] ?? 'English');
    const response = await fetch('/api/system/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceInstallId: installId, uiLanguage, primaryLanguage }),
    });
    if (!response.ok) console.warn('Install analytics request failed.');
  } catch {
    // best-effort analytics
  }
};

const renderSessions = async () => {
  if (!state.authToken || !state.user) return;
  const response = await fetch('/api/user/auth/sessions', { headers: { Authorization: `Bearer ${state.authToken}` } });
  if (!response.ok) return;
  const { sessions, currentSessionId } = await response.json();
  state.currentSessionId = currentSessionId;
  sessionsList.innerHTML = '';
  sessions.forEach((session) => {
    const item = document.createElement('li');
    item.className = 'card-item';
    const active = !session.revokedAt;
    const isCurrent = session.id === currentSessionId;
    item.innerHTML = `<strong>${session.deviceName}</strong><p>${new Date(session.issuedAt).toLocaleString()} ${isCurrent ? '• Current' : ''}</p>`;
    if (active && !isCurrent) {
      const button = document.createElement('button');
      button.className = 'btn btn-sm btn-outline-danger';
      button.textContent = 'Log out this device';
      button.addEventListener('click', async () => {
        await fetch(`/api/user/auth/sessions/${session.id}/logout`, { method: 'POST', headers: { Authorization: `Bearer ${state.authToken}` } });
        renderSessions();
      });
      item.append(button);
    }
    sessionsList.append(item);
  });
  saveState();
};

const renderVenuePanel = async () => {
  if (!state.authToken || !state.user) return;
  await refreshVenueMemberships();
  venuePanelList.innerHTML = '';
  venues.forEach((venue) => {
    const joined = state.joinedVenueIds.includes(venue.id);
    const item = document.createElement('li');
    item.className = 'card-item';
    item.innerHTML = `<strong>${venue.name}</strong><p>${venue.room}</p>`;
    const button = document.createElement('button');
    button.textContent = joined ? 'Leave venue' : 'Join venue';
    button.className = joined ? 'ghost' : '';
    button.addEventListener('click', async () => {
      const endpoint = joined ? `/api/user/venues/${venue.id}/leave` : `/api/user/venues/${venue.id}/join`;
      await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${state.authToken}` } });
      await refreshVenueMemberships();
      renderVenuePanel();
      renderVenues();
    });
    item.append(button);
    venuePanelList.append(item);
  });
};

const renderAdminPanel = async () => {
  if (!canAccessAdminPanel()) {
    adminOverviewCards.innerHTML = '<li class="card-item">Admin panel is available only to admin and venue host accounts.</li>';
    pendingAccessList.innerHTML = '<li class="card-item">Pending requests are visible to admin and venue host accounts only.</li>';
    billingPeriodList.innerHTML = '<li class="card-item">Billing reconciliation is visible to admin and venue host accounts only.</li>';
    return;
  }
  adminOverviewCards.innerHTML = '<li class="card-item">Loading system data…</li>';
  try {
    const [installResponse, scaleResponse] = await Promise.all([
      fetch('/api/system/install-summary', { headers: { Authorization: `Bearer ${state.authToken}` } }),
      fetch('/api/system/scale/recommendation', { headers: { Authorization: `Bearer ${state.authToken}` } }),
    ]);
    if (!installResponse.ok || !scaleResponse.ok) throw new Error('system endpoints unavailable');

    const installSummary = await installResponse.json();
    const scale = await scaleResponse.json();

    const topLanguages = installSummary.byLanguage?.slice(0, 5).map((entry) => `${entry.language}: ${entry.installs}`).join(', ') || '—';
    const topCountries = installSummary.byCountry?.slice(0, 5).map((entry) => `${entry.country.toUpperCase()}: ${entry.installs}`).join(', ') || '—';

    adminOverviewCards.innerHTML = `
      <li class="card-item">
        <strong>PWA Installs</strong>
        <p>Total installs: ${installSummary.totalInstalls}</p>
        <p>Top languages: ${topLanguages}</p>
        <p>Top countries: ${topCountries}</p>
      </li>
      <li class="card-item">
        <strong>Node Scaling Recommendation</strong>
        <p>Need additional node: <b>${scale.recommendNewNode ? 'Yes' : 'No'}</b></p>
        <p>Recommended total nodes: ${scale.recommendedTotalNodes}</p>
        <p>Recommended additional nodes: ${scale.recommendedAdditionalNodes}</p>
        <p>Connected users: ${scale.metrics.connectedUsers}</p>
        <p>Chunks/minute: ${scale.metrics.chunksPerMinute}</p>
        <p>Active venues: ${scale.metrics.activeVenues}</p>
        <p>Reason: ${scale.reasons.join(' ')}</p>
      </li>
    `;
  } catch {
    adminOverviewCards.innerHTML = '<li class="card-item">Admin data unavailable right now.</li>';
  }
  if (!canAccessAdminPanel()) return;
  try {
    const response = await fetch(`/api/venue/${activeVenue().id}/access/pending`, { headers: { Authorization: `Bearer ${state.authToken}` } });
    if (!response.ok) throw new Error('pending unavailable');
    const payload = await response.json();
    pendingAccessList.innerHTML = '';
    if (!payload.pending.length) {
      pendingAccessList.innerHTML = '<li class="card-item">No pending access requests.</li>';
      return;
    }
    payload.pending.forEach((entry) => {
      const item = document.createElement('li');
      item.className = 'card-item';
      item.innerHTML = `<strong>User ${entry.userId}</strong><p>Requested ${new Date(entry.requestedAt).toLocaleString()}</p>`;
      const button = document.createElement('button');
      button.textContent = 'Approve access';
      button.addEventListener('click', async () => {
        await fetch(`/api/venue/${activeVenue().id}/access/${entry.userId}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${state.authToken}` } });
        renderAdminPanel();
      });
      item.append(button);
      pendingAccessList.append(item);
    });
  } catch {
    pendingAccessList.innerHTML = '<li class="card-item">Could not load pending access requests.</li>';
  }
  try {
    const response = await fetch(`/api/system/billing/periods?accountType=venue&accountId=${encodeURIComponent(activeVenue().id)}`, { headers: { Authorization: `Bearer ${state.authToken}` } });
    if (!response.ok) throw new Error('billing periods unavailable');
    const payload = await response.json();
    billingPeriodList.innerHTML = '';
    if (!payload.periods.length) {
      billingPeriodList.innerHTML = '<li class="card-item">No billing periods yet.</li>';
      return;
    }
    payload.periods.slice(0, 6).forEach((period) => {
      const item = document.createElement('li');
      item.className = 'card-item';
      item.innerHTML = `<strong>${new Date(period.periodStart).toLocaleDateString()} - ${new Date(period.periodEnd).toLocaleDateString()}</strong><p>Status: ${period.status}</p><p>Seconds: ${Math.round(period.secondsProcessed)}</p><p>Projected overage: $${Number(period.projectedOverage).toFixed(2)}</p>`;
      if (period.status !== 'reconciled') {
        const button = document.createElement('button');
        button.textContent = 'Mark reconciled';
        button.addEventListener('click', async () => {
          await fetch(`/api/system/billing/periods/${period.id}/reconcile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.authToken}` },
            body: JSON.stringify({ externalRef: `manual-${Date.now()}` }),
          });
          renderAdminPanel();
        });
        item.append(button);
      }
      billingPeriodList.append(item);
    });
  } catch {
    billingPeriodList.innerHTML = '<li class="card-item">Could not load billing periods.</li>';
  }
};

const applySettings = () => {
  notificationToggle.checked = state.settings.notifications;
  darkModeToggle.checked = state.settings.darkmode;
  matchUiLanguageToggle.checked = state.settings.matchUiLanguage;
  document.body.classList.toggle('manual-dark', state.settings.darkmode);
  const uiLanguage = resolvedUiLanguage();
  document.documentElement.lang = uiLanguage;
  uiLanguageStatus.textContent = state.settings.matchUiLanguage
    ? `App language follows your primary language (${uiLanguage}).`
    : 'App language is locked to English for easier navigation.';
  const showAdminControls = canAccessAdminPanel();
  navAdminButton.classList.toggle('d-none', !showAdminControls);
  openAdminPanelButton.classList.toggle('d-none', !showAdminControls);
};

const showScreen = (name) => {
  const requestedAdmin = name === 'admin';
  const safeName = requestedAdmin && !canAccessAdminPanel() ? 'settings' : name;
  nav.classList.toggle('hidden', !['venues', 'room', 'conversation', 'settings', 'admin'].includes(safeName) || isTvMode);

  if (safeName === 'languageSelect') renderLanguageSelector();
  if (safeName === 'languageFluency') renderFluencyEditor();
  if (safeName === 'venues') renderVenues();
  if (safeName === 'room') {
    requestWakeLock();
    configureRealtimeSession('speaker');
    buildStreamControls(speakerControls, 'Speaker');
    renderRoom();
  }
  if (safeName === 'conversation') {
    requestWakeLock();
    configureRealtimeSession('conversation');
    buildStreamControls(conversationControls, 'Conversation');
    renderConversationMessages();
  }
  if (safeName === 'tv') {
    configureRealtimeSession('speaker');
    renderTvTranscript();
  }
  if (safeName === 'settings') {
    renderLanguagePack();
    renderInstallAnalytics();
    renderSessions();
    renderVenuePanel();
  }
  if (safeName === 'admin') renderAdminPanel();
  Object.entries(screens).forEach(([key, element]) => element.classList.toggle('is-active', key === safeName));
};

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const mode = event.submitter?.dataset.mode ?? 'login';
  const email = document.querySelector('#auth-email').value.trim();

  const response = await fetch('/api/user/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, deviceName: navigator.userAgent.slice(0, 80), role: 'user' }),
  });
  if (!response.ok) {
    authStatus.textContent = 'Login failed.';
    return;
  }

  const payload = await response.json();
  state.user = payload.user;
  state.authToken = payload.token;
  state.currentSessionId = payload.sessionId;
  state.languagePack = null;
  await refreshVenueMemberships();
  saveState();
  authStatus.textContent = mode === 'register' ? 'Registration successful.' : 'Login successful.';
  setTimeout(() => showScreen(state.onboardingComplete ? 'venues' : 'languageSelect'), 220);
});

languageSelectForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const selected = [...languageSelectForm.querySelectorAll('input[name="language"]:checked')].map((input) => input.value);
  if (!selected.length) return;
  state.knownLanguages = selected;
  selected.forEach((language) => {
    if (!state.fluencyByLanguage[language]) state.fluencyByLanguage[language] = 'Intermediate';
  });
  saveState();
  showScreen('languageFluency');
});

languageFluencyForm.addEventListener('submit', (event) => {
  event.preventDefault();
  state.knownLanguages.forEach((language) => {
    state.fluencyByLanguage[language] = languageFluencyForm.querySelector(`select[name="fluency-${language}"]`).value;
  });
  state.knownLanguages.sort((a, b) => fluencyScale.indexOf(state.fluencyByLanguage[a]) - fluencyScale.indexOf(state.fluencyByLanguage[b]));
  state.onboardingComplete = true;
  saveState();
  syncLanguagePack();
  showScreen('venues');
});

document.querySelector('#open-settings').addEventListener('click', () => showScreen('settings'));
document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => showScreen(button.dataset.nav)));


scanQrButton.addEventListener('click', () => {
  const modalElement = document.querySelector('#qrModal');
  const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
  modal.show();
  startQrScan();
});

document.querySelector('#qrModal').addEventListener('hidden.bs.modal', () => {
  stopQrScan();
});

applyQrFallback.addEventListener('click', async () => {
  const venueId = parseQrPayload(qrFallback.value);
  if (!venueId) return;
  const allowed = await requestVenueEntry(venueId);
  if (!allowed) return;
  if (joinVenueById(venueId)) {
    bootstrap.Modal.getOrCreateInstance(document.querySelector('#qrModal')).hide();
    qrFallback.value = '';
  }
});

notificationToggle.addEventListener('change', () => {
  state.settings.notifications = notificationToggle.checked;
  saveState();
});

darkModeToggle.addEventListener('change', () => {
  state.settings.darkmode = darkModeToggle.checked;
  applySettings();
  saveState();
});

matchUiLanguageToggle.addEventListener('change', () => {
  state.settings.matchUiLanguage = matchUiLanguageToggle.checked;
  applySettings();
  saveState();
});


endSessionButton.addEventListener('click', () => {
  state.sessionEnded = true;
  roomLiveStatus.textContent = 'Session ended';
  Object.values(micIntervals).forEach((id) => clearInterval(id));
  micIntervals = {};
  if (realtimeSocket) {
    realtimeSocket.emit('session:stop', { venueId: activeVenue().id });
  }
  saveState();
  renderRoom();
  releaseWakeLock();
});

exportCaptionsButton.addEventListener('click', () => {
  const lines = state.liveCaptions.map((entry) => `[${entry.room}] [${entry.language}] ${entry.text}`).join('\n');
  const blob = new Blob([lines || 'No captions captured yet.'], { type: 'text/plain' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'venuechat-captions.txt';
  link.click();
  URL.revokeObjectURL(link.href);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.error('Service worker registration failed:', error);
    });
  });
}

applySettings();
reportInstallAnalytics();
showScreen('splash');
setTimeout(() => {
  if (isTvMode) {
    state.recentVenueId = tvVenueId;
    showScreen('tv');
    return;
  }
  if (state.user && state.onboardingComplete) showScreen('venues');
  else if (state.user) showScreen('languageSelect');
  else showScreen('auth');
}, 1000);
