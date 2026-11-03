/* Bot Nuke — dashboard (vanilla JS, nessun build step) */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const STEPS = [
  { n: 1, label: 'Bot' },
  { n: 2, label: 'Server' },
  { n: 3, label: 'Canali' },
  { n: 4, label: 'Nomi e ordine' },
  { n: 5, label: 'Messaggi' },
  { n: 6, label: 'Tempi e avvio' },
];

const TITLES = {
  overview: ['Panoramica', 'Stato del loop in tempo reale'],
  setup: ['Configurazione', 'Sei passi guidati: token, server, canali, nomi, messaggi, tempi'],
  activity: ['Attività', 'Ogni azione del bot, in ordine cronologico'],
  settings: ['Impostazioni', 'Connessione, ripristino, sicurezza e backup'],
};

const state = {
  data: null,
  view: 'overview',
  step: 1,
  maxStep: 1,
  draft: null,
  logs: [],
  logFilter: 'all',
  startAfter: false,
  changeToken: false,
  refreshing: false,
  timer: null,
  source: null,
  previewTimer: null,
  modalResolve: null,
  setupSig: null,
};

/* ---------------- API ---------------- */

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  let data = null;
  try { data = await res.json(); } catch { /* risposta vuota */ }
  if (!res.ok) {
    const error = new Error(data?.error || `Errore ${res.status}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

/* ---------------- Bootstrap ---------------- */

function showScreen(name) {
  $('#app').hidden = name !== 'app';
  $('#login').hidden = name !== 'login';
  $('#firstrun').hidden = name !== 'firstrun';
  if (name !== 'app' && state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

async function boot() {
  try {
    const status = await api('/auth/status');
    if (!status.hasPassword) { showScreen('firstrun'); return; }
    if (!status.authenticated) { showScreen('login'); return; }
    await enterApp();
  } catch (error) {
    toast(error.message, 'error');
    showScreen('login');
  }
}

async function enterApp() {
  showScreen('app');
  await refresh();
  state.draft = makeDraft(state.data.config);
  connectEvents();
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(refresh, 3000);
  setView(state.view || 'overview');
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const data = await api('/state');
    state.data = data;
    mergeLogs(data.logs ?? []);
    if (!state.draft) state.draft = makeDraft(data.config);
    renderAll();
  } catch (error) {
    if (error.status === 401 || error.status === 428) {
      showScreen(error.status === 401 ? 'login' : 'firstrun');
    }
  } finally {
    state.refreshing = false;
  }
}

function connectEvents() {
  if (state.source) { state.source.close(); state.source = null; }
  const source = new EventSource('/api/events');
  state.source = source;
  source.addEventListener('log', (event) => {
    try {
      const entry = JSON.parse(event.data);
      mergeLogs([entry]);
      renderLogTail();
      if (state.view === 'activity') renderActivity();
    } catch { /* ignora payload malformato */ }
  });
  source.onerror = () => {
    source.close();
    state.source = null;
    if (!$('#app').hidden) setTimeout(connectEvents, 5000);
  };
}

/* ---------------- Rendering ---------------- */

function makeDraft(config) {
  return {
    bot: { guildId: config.bot?.guildId ?? null, guildName: config.bot?.guildName ?? null },
    channels: structuredClone(config.channels ?? { animated: [], message: null }),
    rotation: structuredClone(config.rotation ?? {}),
    messages: structuredClone(config.messages ?? {}),
    loop: structuredClone(config.loop ?? {}),
  };
}

function renderAll() {
  if (!state.data) return;
  renderChrome();
  renderBanner();
  const message = state.data.config?.channels?.message;
  $('#quick-send-channel').textContent = message ? `#${message.name}` : 'nessun canale';
  if (state.view === 'overview') renderOverview();
  if (state.view === 'activity') renderActivity();
  if (state.view === 'settings') renderSettings();
  autoRefreshWizard();
}

/**
 * Firma di ciò che il wizard legge dal server (connessione, elenco server,
 * server scelto, canali). Serve a capire quando ridisegnarlo.
 */
function wizardSignature() {
  const data = state.data;
  if (!data) return '';
  return [
    data.bot?.connected ? 'on' : 'off',
    (data.guilds ?? []).map((guild) => guild.id).join(','),
    data.bot?.guildId ?? '',
    (data.channels ?? []).length,
  ].join('|');
}

/**
 * Il passo 2 elenca i server del bot: se nel frattempo lo inviti su un server
 * la lista deve comparire da sola. Non ridisegna mentre stai scrivendo, per non
 * perdere quello che hai digitato.
 */
function autoRefreshWizard() {
  if (state.view !== 'setup' || !state.data) return;
  const signature = wizardSignature();
  if (signature === state.setupSig) return;
  state.setupSig = signature;
  const active = document.activeElement;
  const typing = active && $('#wizard-body')?.contains(active)
    && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
  if (typing || state.step > 3) return;
  renderWizard();
}

function renderChrome() {
  const data = state.data;
  const bot = data.bot ?? {};
  const cfg = data.config ?? {};
  const guildName = bot.guild?.name || cfg.bot?.guildName || 'nessun server';
  $('#brand-sub').textContent = data.mock ? 'modalità demo' : guildName;
  $('#foot-hint').textContent = data.mock
    ? 'Discord simulato: nessun dato reale'
    : (bot.connected ? `latenza ${bot.latency ?? '—'} ms` : 'completa la configurazione');

  const pill = $('#bot-pill');
  const text = $('.status-text', pill);
  pill.classList.remove('ok', 'warn');
  if (bot.connected) {
    pill.classList.add('ok');
    text.textContent = `${bot.tag ?? 'bot'} online`;
  } else {
    pill.classList.add('warn');
    text.textContent = 'bot offline';
  }

  const running = data.runtime?.running;
  $('#topbar-actions').innerHTML = running
    ? `<span class="badge live">loop attivo</span>${data.runtime.dryRun ? '<span class="badge dry">dry run</span>' : ''}`
    : `<span class="badge off">loop fermo</span>${cfg.setup?.complete ? '' : '<button class="btn primary small" data-action="open-wizard">Configura ora</button>'}`;
}

function renderBanner() {
  const banner = $('#banner');
  const data = state.data;
  const cfg = data.config;
  const bot = data.bot;
  const messages = [];

  if (!cfg.setup?.complete) {
    messages.push({
      html: 'Configurazione incompleta: collega il bot e imposta canali, nomi e messaggi con la procedura guidata.',
      action: '<button class="btn primary small" data-action="open-wizard">Apri configurazione</button>',
      tone: 'warn',
    });
  } else if (!bot.connected) {
    messages.push({
      html: 'Il bot non è connesso a Discord: controlla il token nelle impostazioni.',
      action: '<button class="btn ghost small" data-action="open-settings">Impostazioni</button>',
      tone: 'warn',
    });
  }

  if (!messages.length) { banner.hidden = true; banner.innerHTML = ''; return; }
  banner.hidden = false;
  banner.innerHTML = messages.map((item) => `<span>${esc(item.html)}</span><span class="spacer"></span>${item.action}`).join('');
}

function renderOverview() {
  const data = state.data;
  const cfg = data.config;
  const rt = data.runtime ?? {};
  const bot = data.bot ?? {};
  const animated = cfg.channels?.animated ?? [];
  const preview = rt.preview ?? { names: [], shift: 0 };
  const complete = Boolean(cfg.setup?.complete);
  const liveNames = new Map((rt.budget?.channels ?? []).map((channel) => [channel.id, channel.name]));
  const connected = Boolean(bot.connected);

  const hero = `
    <div class="hero ${rt.running ? 'is-running' : ''}">
      <div>
        <div class="row" style="gap:6px">
          <span class="badge ${rt.running ? 'live' : 'off'}">${rt.running ? 'loop attivo' : 'loop fermo'}</span>
          ${rt.dryRun ? '<span class="badge dry">dry run</span>' : ''}
          ${rt.restore?.active ? '<span class="badge danger">ripristino in corso</span>' : ''}
        </div>
        <h2>${!complete ? 'Configura il bot per iniziare' : rt.running ? 'Il server sta per esplodere' : 'Tutto pronto, loop fermo'}</h2>
        <p class="muted">${
          !complete
            ? 'Sei passi guidati: token, server, canali, nomi, messaggi e tempi. Ci vogliono due minuti.'
            : rt.running
              ? `Tick #${rt.tick ?? 0} · prossima modifica tra poco. ${animated.length} canali animati${rt.dryRun ? ', modalità di prova attiva (Discord non viene toccato)' : ''}.`
              : `La configurazione è salvata. Avvia il loop quando l'evento sta per iniziare.`
        }</p>
        <div class="hero-actions">
          ${rt.running
            ? '<button class="btn danger" data-action="stop">Ferma loop</button>'
            : `<button class="btn primary" data-action="start" ${complete && connected ? '' : 'disabled'}>Avvia loop</button>`}
          <button class="btn ghost" data-action="tick" ${complete && connected ? '' : 'disabled'}>Forza un tick</button>
          <button class="btn danger" data-action="panic" ${cfg.snapshot ? '' : 'disabled'}>Panic · ripristina</button>
        </div>
      </div>
      <div class="hero-count">
        <span class="kpi-label">prossimo tick</span>
        <strong id="countdown">—</strong>
        <span class="muted">tick #${rt.tick ?? 0} · ${animated.length} canali</span>
        <div class="meter-track" style="width:130px;margin-top:8px"><div class="meter-fill" id="countdown-fill"></div></div>
      </div>
    </div>`;

  const stats = cfg.stats ?? {};
  const kpis = `
    <div class="grid-kpi">
      <div class="kpi">
        <span class="kpi-label">bot</span>
        <strong>${esc(bot.tag || 'non connesso')}</strong>
        <small>${bot.connected ? `latenza ${bot.latency ?? '—'} ms` : 'collega il token al passo 1'}</small>
      </div>
      <div class="kpi">
        <span class="kpi-label">server</span>
        <strong>${esc(bot.guild?.name || cfg.bot?.guildName || '—')}</strong>
        <small>${bot.guild?.memberCount ? `${bot.guild.memberCount} membri` : 'nessun server selezionato'}</small>
      </div>
      <div class="kpi">
        <span class="kpi-label">canali messaggi</span>
        <strong>${cfg.messages?.target === 'one' ? esc(cfg.channels?.message?.name || '—') : 'tutti i canali di testo'}</strong>
        <small>${
          cfg.messages?.mode === 'rotation' ? `un burst da ${cfg.messages.repeat} a ogni tick`
            : cfg.messages?.mode === 'timer' ? `ogni ${cfg.messages.intervalSec}s · ${cfg.messages.repeat} copie`
              : 'messaggi disattivati'
        }</small>
      </div>
      <div class="kpi">
        <span class="kpi-label">attività</span>
        <strong class="kpi-value">${stats.ticks ?? 0} tick</strong>
        <small>${stats.renames ?? 0} rinomine · ${stats.messages ?? 0} messaggi</small>
      </div>
    </div>`;

  const previewRows = (preview.names ?? []).map((entry) => {
    const from = liveNames.get(entry.id) ?? entry.channelName ?? '—';
    return `
      <div class="preview-item">
        <span class="from">#${esc(from)}</span>
        <span class="arrow">→</span>
        <span class="to">#${esc(entry.name || '—')}</span>
      </div>`;
  }).join('');

  const previewCard = `
    <div class="card">
      <div class="card-head">
        <div><h3>Anteprima del prossimo tick</h3><p class="muted">Quello che il bot applicherà al tick #${(rt.tick ?? 0) + 1}.</p></div>
        <span class="badge">ordine +${preview.shift ?? 0}</span>
      </div>
      ${previewRows ? `<div class="preview-list">${previewRows}</div>` : '<div class="alert">Nessun canale configurato: apri la configurazione guidata.</div>'}
      ${preview.text ? `<div class="alert" style="margin-top:12px">Messaggio: “${esc(preview.text)}”</div>` : ''}
    </div>`;

  const budgetChannels = (rt.budget?.channels ?? []).map((channel) => {
    const remaining = channel.remaining ?? 0;
    const ready = (channel.nextAt ?? 0) <= Date.now();
    return `
      <div class="meter">
        <div class="meter-head">
          <span>#${esc(channel.name ?? channel.id)}</span>
          <span>${ready ? 'pronto' : `tra ${formatClock(channel.nextAt - Date.now())}`}</span>
        </div>
        <div class="meter-track"><div class="meter-fill ${remaining === 0 ? 'low' : ''}" style="width:${(remaining / 2) * 100}%"></div></div>
      </div>`;
  }).join('');

  const budget = `
    <div class="card">
      <div class="card-head">
        <div><h3>Budget Discord</h3><p class="muted">Due modifiche per canale ogni 10 minuti. Quando finisce, il bot aspetta.</p></div>
        <button class="btn ghost small" data-action="refresh">Aggiorna</button>
      </div>
      <div class="stack" style="gap:12px">
        ${budgetChannels || '<div class="alert">Nessun canale ancora configurato.</div>'}
        <div class="meter">
          <div class="meter-head"><span>Riordino canali</span><span>${rt.budget?.reorder?.remaining ?? 0} / 2 disponibili</span></div>
          <div class="meter-track"><div class="meter-fill ${(rt.budget?.reorder?.remaining ?? 0) === 0 ? 'low' : ''}" style="width:${((rt.budget?.reorder?.remaining ?? 0) / 2) * 100}%"></div></div>
        </div>
      </div>
    </div>`;

  $('#overview-dynamic').innerHTML = hero + kpis + previewCard + budget;
  tickCountdown();
  renderLogTail();
}

function logRow(entry) {
  const time = new Date(entry.at).toLocaleTimeString('it-IT', { hour12: false });
  return `<div class="log-row ${esc(entry.level)}"><span class="log-time">${esc(time)}</span><span class="log-level">${esc(entry.level)}</span><span class="log-msg">${esc(entry.message)}</span></div>`;
}

function renderLogTail() {
  const container = $('#log-tail');
  if (!container) return;
  const entries = state.logs.slice(-30);
  container.innerHTML = entries.length
    ? entries.map(logRow).join('')
    : '<div class="log-empty">Nessuna attività: avvia il loop per vedere i tick.</div>';
  container.scrollTop = container.scrollHeight;
}

function renderActivity() {
  const container = $('#activity-list');
  if (!container) return;
  const entries = state.logFilter === 'all'
    ? state.logs
    : state.logs.filter((entry) => entry.level === state.logFilter);
  container.innerHTML = entries.length
    ? entries.slice(-300).reverse().map(logRow).join('')
    : '<div class="log-empty">Nessun evento per questo filtro.</div>';
}

function renderSettings() {
  const data = state.data;
  const bot = data.bot ?? {};
  const cfg = data.config ?? {};
  $('#settings-bot').innerHTML = `
    <div class="bot-card">
      <div class="bot-avatar">${bot.avatar ? `<img src="${esc(bot.avatar)}" alt="">` : '☢'}</div>
      <div class="bot-meta"><strong>${esc(bot.tag || 'non connesso')}</strong><span>${bot.id ? `id ${esc(bot.id)}` : 'nessun token salvato'}</span></div>
      <div class="spacer"></div>
      <span class="badge ${bot.connected ? 'ok' : 'off'}">${bot.connected ? 'online' : 'offline'}</span>
    </div>
    <div class="grid-kpi">
      <div class="kpi"><span class="kpi-label">server</span><strong>${esc(bot.guild?.name || cfg.bot?.guildName || '—')}</strong><small>${esc(bot.guild?.id || cfg.bot?.guildId || '—')}</small></div>
      <div class="kpi"><span class="kpi-label">permessi</span><strong>${bot.guild?.permissionsOk ? 'tutti presenti' : (bot.guild?.missing?.length ? 'mancanti' : 'non verificati')}</strong><small>${esc((bot.guild?.missing ?? []).join(', ') || 'gestione canali e invio messaggi')}</small></div>
      <div class="kpi"><span class="kpi-label">token</span><strong style="font-family:var(--mono)">${esc(bot.tokenPreview || '—')}</strong><small>salvato solo sul tuo server</small></div>
    </div>
    ${bot.connected ? '<div class="row"><button class="btn ghost small" data-action="copy-invite">Copia link di invito</button></div>' : ''}
  `;

  const snapshot = cfg.snapshot;
  $('#settings-snapshot').innerHTML = snapshot
    ? `<div class="alert ok">Nomi originali salvati il ${new Date(snapshot.takenAt).toLocaleString('it-IT')} per ${snapshot.channels} canali${snapshot.restoredAt ? ` · già ripristinati il ${new Date(snapshot.restoredAt).toLocaleString('it-IT')}` : ''}.</div>
       <div class="row">
         <button class="btn danger" data-action="restore">Ripristina nomi e ordine</button>
         <button class="btn ghost small" data-action="snapshot">Aggiorna lo snapshot</button>
       </div>`
    : '<div class="alert">Nessuno snapshot disponibile: viene creato automaticamente al primo avvio del loop.</div>';

  $('#about-version').textContent = `Versione ${data.version}${data.mock ? ' · modalità demo (Discord simulato)' : ''}`;
  $('#settings-token').placeholder = data.mock ? 'Modalità demo: token non necessario' : 'Nuovo token del bot';
}

/* ---------------- Viste ---------------- */

function setView(view) {
  state.view = view;
  $$('.nav-item').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));
  $$('.view').forEach((section) => { section.hidden = section.id !== `view-${view}`; });
  const [title, sub] = TITLES[view] ?? TITLES.overview;
  $('#page-title').textContent = title;
  $('#page-sub').textContent = sub;

  if (view === 'setup') openWizard();
  if (view === 'overview') renderOverview();
  if (view === 'activity') renderActivity();
  if (view === 'settings') renderSettings();
}

/* ---------------- Wizard ---------------- */

function openWizard(step) {
  if (!state.draft && state.data) state.draft = makeDraft(state.data.config);
  if (step) { state.step = step; state.maxStep = Math.max(state.maxStep, step); }
  state.maxStep = Math.max(state.maxStep || 1, state.step);
  renderWizard();
  state.setupSig = wizardSignature();
}

function renderWizard() {
  if (!state.data) return;
  $('#wizard-rail').innerHTML = STEPS.map((step) => {
    const classes = step.n === state.step ? 'is-current' : (step.n < state.step ? 'is-done' : '');
    return `<button class="rail-item ${classes}" data-action="wizard-goto" data-step="${step.n}" ${step.n > state.maxStep ? 'disabled' : ''}>
      <span class="num">${step.n < state.step ? '✓' : step.n}</span><span>${step.label}</span>
    </button>`;
  }).join('');

  $('#wizard-body').innerHTML = renderStep(state.step);
  $('#wizard-foot').innerHTML = `
    <button class="btn ghost" data-action="wizard-back" ${state.step === 1 ? 'disabled' : ''}>Indietro</button>
    <div class="spacer"></div>
    <span class="hint">Passo ${state.step} di ${STEPS.length}</span>
    <button class="btn primary" data-action="wizard-next">${state.step === STEPS.length ? 'Salva configurazione' : 'Avanti'}</button>
  `;
  if (state.step === 4 || state.step === 5) loadPreview();
}

function renderStep(step) {
  switch (step) {
    case 1: return stepBot();
    case 2: return stepGuild();
    case 3: return stepChannels();
    case 4: return stepNames();
    case 5: return stepMessages();
    case 6: return stepTiming();
    default: return '';
  }
}

function stepBot() {
  const data = state.data;
  const bot = data.bot ?? {};
  const connected = Boolean(bot.connected);
  const showForm = !connected || state.changeToken;
  return `
    <div class="card">
      <div class="card-head">
        <div><h2>1 · Collega il bot</h2><p class="muted">Il token resta sul tuo server, dentro il volume di Umbrel.</p></div>
        <span class="badge ${connected ? 'ok' : 'off'}">${connected ? 'token valido' : 'in attesa'}</span>
      </div>
      ${connected && !showForm ? `
        <div class="bot-card">
          <div class="bot-avatar">${bot.avatar ? `<img src="${esc(bot.avatar)}" alt="">` : '☢'}</div>
          <div class="bot-meta"><strong>${esc(bot.tag)}</strong><span>id ${esc(bot.id)}</span></div>
          <div class="spacer"></div>
          <span class="badge ok">connesso</span>
          <button class="btn ghost small" data-action="change-token">Sostituisci token</button>
        </div>` : `
        <form class="stack" data-form="token">
          <label class="field">
            <span>Token del bot</span>
            <input id="token-input" type="password" autocomplete="off" placeholder="${data.mock ? 'Modalità demo: nessun token richiesto' : 'MTIzNDU2Nzg5…'}">
            <small>${data.mock ? 'Stai usando il Discord simulato: premi il pulsante per collegarlo.' : 'Chi ha questo token controlla il bot: non condividerlo.'}</small>
          </label>
          <div class="row"><button class="btn primary" type="submit">Verifica e connetti</button></div>
        </form>`}
      <details class="details">
        <summary>Come ottenere il token in 30 secondi</summary>
        <ol class="help-list" style="margin-top:10px">
          <li>Apri <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">discord.com/developers/applications</a> e premi <em>New Application</em>.</li>
          <li>Sezione <em>Bot</em> → <em>Reset Token</em> → copia il valore.</li>
          <li>Incollalo qui sopra e premi <em>Verifica e connetti</em>.</li>
        </ol>
      </details>
    </div>`;
}

function stepGuild() {
  const data = state.data;
  const guilds = data.guilds ?? [];
  const selected = state.draft?.bot?.guildId;
  const invite = data.bot?.inviteUrl;
  return `
    <div class="card">
      <div class="card-head">
        <div><h2>2 · Scegli il server</h2><p class="muted">Il bot deve essere già nel server, con il permesso "Gestire i canali".</p></div>
        <span class="badge">${guilds.length} server</span>
      </div>
      ${guilds.length ? `<div class="pick-grid">
        ${guilds.map((guild) => `
          <button class="pick-card ${guild.id === selected ? 'is-selected' : ''}" data-action="pick-guild" data-guild="${esc(guild.id)}">
            <span class="pick-icon">${guild.icon ? `<img src="${esc(guild.icon)}" alt="">` : '#'}</span>
            <span class="pick-body">
              <strong>${esc(guild.name)}</strong>
              <small>${guild.memberCount ? `${guild.memberCount} membri` : 'membri non disponibili'}${guild.missing?.length ? ` · manca: ${esc(guild.missing.join(', '))}` : ''}</small>
            </span>
          </button>`).join('')}
      </div>` : `<div class="alert warn">Il bot non è ancora in nessun server. Aprilo col link qui sotto (scope <strong>bot</strong>), autorizza, poi premi <em>Ricontrolla i server</em>: se l'invito è andato a buon fine la lista compare anche da sola entro pochi secondi.</div>
        ${data.bot?.tag ? `<p class="hint" style="margin-top:8px">Connesso come <strong>${esc(data.bot.tag)}</strong> (id ${esc(data.bot.id)}). Se non è il bot che hai invitato, il token al passo 1 è di un'altra applicazione.</p>` : ''}`}
      <div class="row" style="margin-top:14px">
        <button class="btn ghost small" data-action="refresh-guilds">Ricontrolla i server</button>
        ${invite ? `<button class="btn ghost small" data-action="copy-invite">Copia link di invito</button>
          <a class="btn ghost small" href="${esc(invite)}" target="_blank" rel="noreferrer">Apri invito Discord</a>` : ''}
      </div>
      ${data.bot?.guild?.missing?.length ? `<div class="alert warn" style="margin-top:12px">Permessi mancanti: ${esc(data.bot.guild.missing.join(', '))}. Senza "Gestire i canali" il bot non può rinominare.</div>` : ''}
    </div>`;
}

function stepChannels() {
  const data = state.data;
  const all = data.channels ?? [];
  const animated = new Set((state.draft?.channels?.animated ?? []).map((channel) => channel.id));
  const messageId = state.draft?.channels?.message?.id ?? '';
  const target = state.draft?.messages?.target === 'one' ? 'one' : 'all';
  const categories = all.filter((channel) => channel.type === 4).sort((a, b) => a.position - b.position);
  const selectable = all.filter((channel) => [0, 2, 5, 13, 15, 16].includes(channel.type));

  const groups = [];
  for (const category of categories) {
    const items = selectable.filter((channel) => channel.parentId === category.id);
    if (items.length) groups.push({ name: category.name, items });
  }
  const loose = selectable.filter((channel) => !channel.parentId || !categories.some((category) => category.id === channel.parentId));
  if (loose.length) groups.push({ name: 'Senza categoria', items: loose });

  return `
    <div class="card">
      <div class="card-head">
        <div><h2>3 · Canali</h2><p class="muted">Scegli cosa animare e dove scrivere i messaggi.</p></div>
        <span class="badge">${animated.size} selezionati</span>
      </div>
      ${!all.length ? '<div class="alert warn">Nessun canale disponibile: connetti il bot e scegli un server al passo 2.</div>' : `
        <div class="channel-groups">
          ${groups.map((group) => `
            <div class="channel-group">
              <h4>${esc(group.name)}</h4>
              ${group.items.map((channel) => `
                <label class="channel-row">
                  <input type="checkbox" data-channel-id="${esc(channel.id)}" ${animated.has(channel.id) ? 'checked' : ''}>
                  <span class="name">#${esc(channel.name)}</span>
                  <span class="type">${esc(channel.typeLabel)}</span>
                </label>`).join('')}
            </div>`).join('')}
        </div>
        <div class="field" style="margin-top:16px">
          <span>Dove inviare i messaggi</span>
          <div class="row" style="gap:20px;margin-top:8px;flex-wrap:wrap">
            <label class="channel-row" style="padding:0">
              <input type="radio" name="msg-target" value="all" ${target === 'all' ? 'checked' : ''}>
              <span class="name">Tutti i canali di testo</span>
            </label>
            <label class="channel-row" style="padding:0">
              <input type="radio" name="msg-target" value="one" ${target === 'one' ? 'checked' : ''}>
              <span class="name">Un solo canale</span>
            </label>
          </div>
          <small>Con “tutti” il bot scrive in ogni canale di testo in cui ha il permesso di inviare messaggi.</small>
          <select id="message-channel" style="margin-top:10px" ${target === 'one' ? '' : 'hidden'}>
            <option value="">— nessuno —</option>
            ${all.filter((channel) => [0, 5].includes(channel.type)).map((channel) => `<option value="${esc(channel.id)}" ${channel.id === messageId ? 'selected' : ''}>#${esc(channel.name)}</option>`).join('')}
          </select>
        </div>`}
    </div>`;
}

function stepNames() {
  const draft = state.draft;
  const animated = draft?.channels?.animated ?? [];
  const rotation = draft?.rotation ?? {};
  if (!animated.length) {
    return `<div class="card"><div class="card-head"><h2>4 · Nomi e ordine</h2></div><div class="alert warn">Torna al passo 3 e seleziona almeno un canale.</div></div>`;
  }
  return `
    <div class="card">
      <div class="card-head"><div><h2>4 · Nomi e ordine</h2><p class="muted">Un nome per riga: il canale li usa a turno, un tick alla volta.</p></div></div>
      <div class="toggles" style="margin-bottom:14px">
        <label class="switch"><input type="checkbox" id="apply-names" ${rotation.applyNames ? 'checked' : ''}><span class="track"></span><span class="label">Cambia i nomi</span></label>
        <label class="switch"><input type="checkbox" id="apply-order" ${rotation.applyOrder ? 'checked' : ''}><span class="track"></span><span class="label">Cambia l'ordine</span></label>
      </div>
      <div class="name-editor">
        ${animated.map((channel) => {
          const variants = rotation.names?.[channel.id] ?? [];
          return `<div class="name-row">
            <div class="channel-label"><strong>#${esc(channel.name)}</strong><span class="hint">${channel.type === 2 ? 'canale vocale' : 'canale testuale'}</span></div>
            <textarea data-names="${esc(channel.id)}" rows="3" placeholder="🎉-festa-{n}&#10;🔥-evento-{n}">${esc(variants.join('\n'))}</textarea>
            <button class="btn ghost small" data-action="suggest-names" data-channel="${esc(channel.id)}">Suggerisci</button>
          </div>`;
        }).join('')}
      </div>
      <label class="field" style="margin-top:16px">
        <span>Rotazione dell'ordine</span>
        <input id="shifts" value="${esc((rotation.shifts ?? [0]).join(', '))}">
        <small>Di quante posizioni scorrere la lista a ogni tick: <code>0, 1, 2</code> significa fermo, +1, +2, poi riparte.</small>
      </label>
      <p class="hint" style="margin-top:8px">Template: <code>{n}</code> numero del tick · <code>{time}</code> ora · <code>{date}</code> data · <code>{rand:🔥|💥}</code> a caso.</p>
      <div id="wizard-preview" style="margin-top:16px"></div>
    </div>`;
}

function stepMessages() {
  const messages = state.draft?.messages ?? {};
  const modes = [['rotation', 'A ogni tick'], ['timer', 'Timer indipendente'], ['off', 'Disattivati']];
  return `
    <div class="card">
      <div class="card-head"><div><h2>5 · Messaggi</h2><p class="muted">Il testo da ripetere in chat, quante copie e con che ritmo.</p></div></div>
      <div class="toggles" style="margin-bottom:14px">
        ${modes.map(([value, label]) => `<button class="chip ${messages.mode === value ? 'is-active' : ''}" data-action="set-message-mode" data-mode="${value}">${label}</button>`).join('')}
      </div>
      <label class="field">
        <span>Testi (uno per riga, ruotano)</span>
        <textarea id="message-texts" rows="4" placeholder="🔥 L'evento inizia ora!&#10;💥 Entra nel vocale!">${esc((messages.texts ?? []).join('\n'))}</textarea>
        <small>Template <code>{n}</code>, <code>{time}</code>, <code>{rand:…}</code> supportati. Max 1900 caratteri per riga.</small>
      </label>
      <div class="form-grid" style="margin-top:14px">
        <label class="field compact"><span>Copie per burst</span><input id="msg-repeat" type="number" min="1" max="25" value="${messages.repeat ?? 3}"></label>
        <label class="field compact"><span>Attesa tra copie (ms)</span><input id="msg-gap" type="number" min="300" max="60000" step="100" value="${messages.gapMs ?? 1200}"></label>
        <label class="field compact"><span>Timer (secondi)</span><input id="msg-interval" type="number" min="5" max="3600" value="${messages.intervalSec ?? 60}" ${messages.mode === 'timer' ? '' : 'disabled'}></label>
      </div>
      <div class="toggles" style="margin-top:14px">
        <label class="switch"><input type="checkbox" id="allow-mentions" ${messages.allowMentions ? 'checked' : ''}><span class="track"></span><span class="label">Consenti @everyone e menzioni</span></label>
      </div>
      <div class="alert" style="margin-top:12px">Discord accetta circa 5 messaggi ogni 5 secondi per canale: i burst più lunghi vengono spalmati automaticamente.</div>
      <div id="wizard-preview" style="margin-top:16px"></div>
    </div>`;
}

function stepTiming() {
  const draft = state.draft;
  const loop = draft?.loop ?? {};
  const interval = Number(loop.intervalSec) || 300;
  const per10 = 600 / interval;
  const namesCount = Object.values(draft?.rotation?.names ?? {}).reduce((total, list) => total + list.length, 0);
  const warn = per10 > 2;
  return `
    <div class="card">
      <div class="card-head"><div><h2>6 · Tempi e avvio</h2><p class="muted">Ultimo passo: quanto spesso agire e se partire subito.</p></div></div>
      <div class="form-grid">
        <label class="field"><span>Intervallo del tick (secondi)</span>
          <input id="loop-interval" type="number" min="30" max="86400" value="${interval}">
          <small>Ogni quanto il bot applica nomi, ordine e messaggi.</small>
        </label>
        <label class="field"><span>Jitter (secondi)</span>
          <input id="loop-jitter" type="number" min="0" max="120" value="${loop.jitterSec ?? 15}">
          <small>Variazione casuale, per non sembrare un cron.</small>
        </label>
      </div>
      <div class="toggles" style="margin-top:16px">
        <label class="switch"><input type="checkbox" id="loop-dry-run" ${loop.dryRun ? 'checked' : ''}><span class="track"></span><span class="label">Dry run: simula senza toccare Discord</span></label>
        <label class="switch"><input type="checkbox" id="loop-auto-start" ${loop.autoStart ? 'checked' : ''}><span class="track"></span><span class="label">Riavvia il loop al boot</span></label>
        <label class="switch"><input type="checkbox" id="start-after" ${state.startAfter ? 'checked' : ''}><span class="track"></span><span class="label">Avvia subito dopo il salvataggio</span></label>
      </div>
      <div class="alert ${warn ? 'warn' : ''}" style="margin-top:14px">
        Con <strong>${interval}s</strong> ogni canale cambierebbe nome <strong>${per10.toFixed(1)}</strong> volte ogni 10 minuti.
        Discord ne consente <strong>2</strong>: quelle in eccesso vengono rimandate senza errori.
      </div>
      <div class="alert" style="margin-top:10px">
        Riepilogo: ${draft?.channels?.animated?.length ?? 0} canali · ${namesCount} nomi a rotazione ·
        ${(draft?.messages?.texts ?? []).length} testi ·
        ${draft?.rotation?.applyOrder ? `ordine +${(draft?.rotation?.shifts ?? [0]).join('/+')}` : 'ordine invariato'}.
      </div>
      <div class="alert ${loop.dryRun ? 'ok' : 'danger'}" style="margin-top:10px">
        ${loop.dryRun
          ? 'Dry run attivo: perfetto per provare. Quando sei sicuro, disattivalo per far cambiare davvero i canali.'
          : 'Attenzione: i nomi dei canali verranno modificati davvero nel server.'}
      </div>
    </div>`;
}

/* ---------------- Wizard: stato ---------------- */

function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function collectStep(step) {
  const draft = state.draft;
  if (!draft) return;

  if (step === 3) {
    const channels = state.data.channels ?? [];
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    const checked = $$('#wizard-body input[data-channel-id]:checked').map((input) => input.dataset.channelId);
    draft.channels.animated = checked.map((id) => {
      const channel = byId.get(id);
      const previous = draft.channels.animated.find((item) => item.id === id);
      return { id, name: channel?.name ?? previous?.name ?? '', type: channel?.type ?? previous?.type ?? 0 };
    });
    const select = $('#message-channel');
    if (select) {
      const id = select.value;
      draft.channels.message = id ? { id, name: byId.get(id)?.name ?? '' } : null;
    }
    const target = $('input[name="msg-target"]:checked');
    if (target) draft.messages.target = target.value === 'one' ? 'one' : 'all';
    for (const key of Object.keys(draft.rotation.names ?? {})) {
      if (!checked.includes(key)) delete draft.rotation.names[key];
    }
  }

  if (step === 4) {
    const names = {};
    $$('#wizard-body textarea[data-names]').forEach((textarea) => {
      const list = textarea.value.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 30);
      if (list.length) names[textarea.dataset.names] = list;
    });
    draft.rotation.names = names;
    if ($('#apply-names')) draft.rotation.applyNames = $('#apply-names').checked;
    if ($('#apply-order')) draft.rotation.applyOrder = $('#apply-order').checked;
    if ($('#shifts')) {
      const shifts = $('#shifts').value.split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 60)
        .slice(0, 24);
      draft.rotation.shifts = shifts.length ? shifts : [0];
    }
  }

  if (step === 5) {
    if ($('#message-texts')) {
      draft.messages.texts = $('#message-texts').value.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 50);
    }
    if ($('#msg-repeat')) draft.messages.repeat = clampInt($('#msg-repeat').value, 1, 25, 3);
    if ($('#msg-gap')) draft.messages.gapMs = clampInt($('#msg-gap').value, 300, 60000, 1200);
    if ($('#msg-interval')) draft.messages.intervalSec = clampInt($('#msg-interval').value, 5, 3600, 60);
    if ($('#allow-mentions')) draft.messages.allowMentions = $('#allow-mentions').checked;
    draft.messages.enabled = draft.messages.mode !== 'off';
  }

  if (step === 6) {
    if ($('#loop-interval')) draft.loop.intervalSec = clampInt($('#loop-interval').value, 30, 86400, 300);
    if ($('#loop-jitter')) draft.loop.jitterSec = clampInt($('#loop-jitter').value, 0, 120, 15);
    if ($('#loop-dry-run')) draft.loop.dryRun = $('#loop-dry-run').checked;
    if ($('#loop-auto-start')) draft.loop.autoStart = $('#loop-auto-start').checked;
    if ($('#start-after')) state.startAfter = $('#start-after').checked;
  }
}

function validateStep(step) {
  const draft = state.draft;
  if (step === 1 && !state.data.bot?.connected) return 'Collega prima il bot con un token valido.';
  if (step === 2 && !draft.bot?.guildId) return 'Scegli il server su cui far girare l\'evento.';
  if (step === 3) {
    if (!draft.channels.animated.length) return 'Seleziona almeno un canale da animare.';
    if (draft.messages.enabled && draft.messages.mode !== 'off' && draft.messages.target === 'one' && !draft.channels.message) {
      return 'Scegli il canale dove inviare i messaggi.';
    }
  }
  if (step === 4 && draft.rotation.applyNames) {
    for (const channel of draft.channels.animated) {
      if (!(draft.rotation.names[channel.id]?.length)) return `Scrivi almeno un nome per #${channel.name}.`;
    }
  }
  if (step === 5 && draft.messages.enabled && draft.messages.mode !== 'off') {
    if (!draft.messages.texts.length) return 'Scrivi almeno un messaggio da inviare.';
  }
  return null;
}

async function gotoStep(step) {
  if (step === state.step) return;
  collectStep(state.step);
  if (step > state.step) {
    const error = validateStep(state.step);
    if (error) { toast(error, 'warn'); return; }
  }
  state.step = Math.min(6, Math.max(1, step));
  state.maxStep = Math.max(state.maxStep, state.step);
  renderWizard();
}

async function nextStep() {
  collectStep(state.step);
  const error = validateStep(state.step);
  if (error) { toast(error, 'warn'); return; }
  if (state.step < STEPS.length) {
    state.step += 1;
    state.maxStep = Math.max(state.maxStep, state.step);
    renderWizard();
    return;
  }
  await saveWizard();
}

async function saveWizard() {
  collectStep(6);
  const start = Boolean($('#start-after')?.checked);
  try {
    const response = await api('/setup/complete', { method: 'POST', body: { config: state.draft, start } });
    state.maxStep = STEPS.length;
    if (response.state) {
      state.data = response.state;
      mergeLogs(response.state.logs ?? []);
    } else {
      await refresh();
    }
    state.draft = makeDraft(state.data.config);
    toast(start ? 'Configurazione salvata: loop avviato.' : 'Configurazione salvata.', 'success');
    setView('overview');
  } catch (error) {
    const detail = error.data?.errors?.slice(0, 3).join(' ') ?? error.message;
    toast(detail, 'error');
  }
}

async function loadPreview() {
  const container = $('#wizard-preview');
  if (!container || !state.draft) return;
  try {
    const response = await api('/preview', {
      method: 'POST',
      body: { config: state.draft, ticks: 6, fromTick: state.data?.runtime?.tick ?? 0 },
    });
    const names = new Map((state.data.channels ?? []).map((channel) => [channel.id, channel.name]));
    container.innerHTML = `
      <p class="hint" style="margin-bottom:8px">Anteprima dei prossimi 6 tick</p>
      <div class="preview-table">
        ${response.frames.map((frame) => `
          <div class="preview-line">
            <span class="tick">#${frame.index + 1}</span>
            <div>
              <div class="chips">
                ${frame.names.map((entry) => `<span>${esc(names.get(entry.id) ?? entry.channelName ?? '')} → <b>${esc(entry.name || '—')}</b></span>`).join('')}
              </div>
              ${frame.text ? `<div class="preview-msg">“${esc(frame.text)}”</div>` : ''}
            </div>
            <span class="shift">ordine +${frame.shift}</span>
          </div>`).join('')}
      </div>`;
  } catch (error) {
    container.innerHTML = `<div class="alert warn">Anteprima non disponibile: ${esc(error.message)}</div>`;
  }
}

/* ---------------- Azioni ---------------- */

async function control(action) {
  try {
    await api('/control', { method: 'POST', body: { action } });
    await refresh();
    if (action === 'start') toast('Loop avviato.', 'success');
    if (action === 'stop') toast('Loop fermato. I canali restano come sono.', 'warn');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function selectGuild(guildId) {
  try {
    const response = await api('/bot/guild', { method: 'POST', body: { guildId } });
    if (state.draft) {
      state.draft.bot.guildId = guildId;
      state.draft.bot.guildName = response.guild?.name ?? null;
      const available = new Set((response.channels ?? []).map((channel) => channel.id));
      state.draft.channels.animated = state.draft.channels.animated.filter((channel) => available.has(channel.id));
    }
    await refresh();
    renderWizard();
    toast(`Server selezionato: ${response.guild?.name ?? guildId}`, 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function sendNow() {
  const text = $('#quick-text').value.trim();
  if (!text) { toast('Scrivi il messaggio da inviare.', 'warn'); return; }
  const count = clampInt($('#quick-count').value, 1, 25, 1);
  const gapMs = clampInt($('#quick-gap').value, 300, 60000, 1200);
  try {
    await api('/control/send', { method: 'POST', body: { text, count, gapMs } });
    toast(`Invio di ${count} messaggi avviato.`, 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function copyInvite() {
  const url = state.data?.bot?.inviteUrl;
  if (!url) { toast('Link di invito non disponibile: collega prima il bot.', 'warn'); return; }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => toast('Link di invito copiato.', 'success'))
      .catch(() => window.open(url, '_blank', 'noopener'));
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

function suggestNames(channelId) {
  const channel = state.draft?.channels?.animated?.find((item) => item.id === channelId);
  const textarea = $(`#wizard-body textarea[data-names="${CSS.escape(channelId)}"]`);
  if (!textarea) return;
  const ideas = channel?.type === 2
    ? ['🔊 Sala {n}', '🎧 Musica {n}', '🎤 Palco {n}', '💥 Party {n}']
    : ['🎉-festa-{n}', '🔥-hype-{n}', '💥-evento-{n}', '⚡-live-{n}'];
  textarea.value = ideas.join('\n');
  collectStep(4);
  state.maxStep = Math.max(state.maxStep, 4);
  loadPreview();
  toast('Nomi di esempio inseriti: modificali come vuoi.', 'success');
}

/* ---------------- Toast e modale ---------------- */

function toast(message, type = 'info') {
  const container = $('#toasts');
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  container.appendChild(element);
  setTimeout(() => {
    element.style.opacity = '0';
    element.style.transition = 'opacity .2s';
    setTimeout(() => element.remove(), 220);
  }, 4200);
}

function confirmAction({ title, text, confirmLabel = 'Conferma', danger = false }) {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text;
    const button = $('#modal-confirm');
    button.textContent = confirmLabel;
    button.className = `btn ${danger ? 'danger' : 'primary'}`;
    $('#modal').hidden = false;
    state.modalResolve = resolve;
  });
}

function closeModal(value) {
  $('#modal').hidden = true;
  const resolve = state.modalResolve;
  state.modalResolve = null;
  if (resolve) resolve(value);
}

/* ---------------- Eventi ---------------- */

function mergeLogs(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  const known = new Set(state.logs.map((entry) => entry.id));
  for (const entry of entries) {
    if (!entry || known.has(entry.id)) continue;
    state.logs.push(entry);
    known.add(entry.id);
  }
  state.logs.sort((a, b) => a.id - b.id);
  if (state.logs.length > 500) state.logs = state.logs.slice(-500);
}

document.addEventListener('click', async (event) => {
  const navButton = event.target.closest('[data-view]');
  if (navButton) { setView(navButton.dataset.view); return; }

  const filterButton = event.target.closest('[data-filter]');
  if (filterButton) {
    state.logFilter = filterButton.dataset.filter;
    $$('#log-filters .chip').forEach((chip) => chip.classList.toggle('is-active', chip.dataset.filter === state.logFilter));
    renderActivity();
    return;
  }

  const element = event.target.closest('[data-action]');
  if (!element) return;
  const action = element.dataset.action;

  switch (action) {
    case 'logout':
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      if (state.source) { state.source.close(); state.source = null; }
      state.data = null;
      state.draft = null;
      state.logs = [];
      showScreen('login');
      break;
    case 'open-wizard':
      setView('setup');
      openWizard(1);
      break;
    case 'open-settings':
      setView('settings');
      break;
    case 'go-activity':
      setView('activity');
      break;
    case 'refresh':
      await refresh();
      break;
    case 'start':
    case 'stop':
    case 'tick':
      await control(action);
      break;
    case 'panic': {
      const confirmed = await confirmAction({
        title: 'Panic: ferma e ripristina?',
        text: 'Il loop si ferma e il bot prova a riportare nomi e ordine originali. Rispetta i limiti Discord, quindi può richiedere qualche minuto.',
        confirmLabel: 'Sì, ripristina',
        danger: true,
      });
      if (confirmed) {
        await api('/control', { method: 'POST', body: { action: 'panic' } }).catch((error) => toast(error.message, 'error'));
        await refresh();
      }
      break;
    }
    case 'restore': {
      const confirmed = await confirmAction({
        title: 'Ripristinare i canali?',
        text: 'Nomi e ordine tornano a com\'erano prima del primo avvio. Il loop viene fermato.',
        confirmLabel: 'Ripristina',
        danger: true,
      });
      if (confirmed) {
        await api('/control', { method: 'POST', body: { action: 'restore' } }).catch((error) => toast(error.message, 'error'));
        await refresh();
      }
      break;
    }
    case 'snapshot':
      await api('/control', { method: 'POST', body: { action: 'snapshot' } }).catch((error) => toast(error.message, 'error'));
      await refresh();
      toast('Snapshot aggiornato con i nomi attuali.', 'success');
      break;
    case 'change-token':
      state.changeToken = true;
      renderWizard();
      break;
    case 'pick-guild':
      await selectGuild(element.dataset.guild);
      break;
    case 'wizard-goto':
      await gotoStep(Number(element.dataset.step));
      break;
    case 'wizard-back':
      collectStep(state.step);
      state.step = Math.max(1, state.step - 1);
      renderWizard();
      break;
    case 'wizard-next':
      await nextStep();
      break;
    case 'suggest-names':
      suggestNames(element.dataset.channel);
      break;
    case 'set-message-mode': {
      collectStep(5);
      state.draft.messages.mode = element.dataset.mode;
      state.draft.messages.enabled = element.dataset.mode !== 'off';
      renderWizard();
      break;
    }
    case 'send-now':
      await sendNow();
      break;
    case 'refresh-guilds': {
      try {
        const result = await api('/bot/guilds');
        state.data.guilds = result.guilds ?? [];
        state.setupSig = wizardSignature();
        renderWizard();
        toast(
          state.data.guilds.length
            ? `${state.data.guilds.length} server disponibili.`
            : 'Nessun server: invita il bot con il link qui sotto e riprova.',
          state.data.guilds.length ? 'success' : 'warn',
        );
      } catch (error) {
        toast(error.message, 'error');
      }
      break;
    }
    case 'copy-invite':
      copyInvite();
      break;
    case 'export':
      window.location.href = '/api/export';
      break;
    case 'modal-cancel':
      closeModal(false);
      break;
    case 'modal-confirm':
      closeModal(true);
      break;
    default:
      break;
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form;

  if (kind === 'login') {
    const password = $('#login-password').value;
    try {
      await api('/auth/login', { method: 'POST', body: { password } });
      $('#login-hint').textContent = '';
      await enterApp();
    } catch (error) {
      $('#login-hint').textContent = error.message;
    }
    return;
  }

  if (kind === 'setup-password') {
    const password = $('#setup-password').value;
    const confirm = $('#setup-password-2').value;
    if (password !== confirm) { toast('Le password non coincidono.', 'warn'); return; }
    try {
      await api('/auth/setup', { method: 'POST', body: { password } });
      toast('Dashboard creata.', 'success');
      await enterApp();
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }

  if (kind === 'token') {
    const input = $('#token-input') ?? $('#settings-token');
    const token = input?.value.trim() ?? '';
    try {
      await api('/bot/token', { method: 'POST', body: { token } });
      state.changeToken = false;
      await refresh();
      if (state.view === 'setup') renderWizard();
      toast('Bot connesso.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }

  if (kind === 'password') {
    const current = $('#pw-current').value;
    const next = $('#pw-next').value;
    const confirm = $('#pw-confirm').value;
    if (next !== confirm) { toast('Le nuove password non coincidono.', 'warn'); return; }
    try {
      await api('/password', { method: 'POST', body: { current, next } });
      form.reset();
      toast('Password aggiornata.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }
});

document.addEventListener('input', (event) => {
  if (!event.target.closest('#wizard-body')) return;
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(() => {
    if (state.view !== 'setup') return;
    try { collectStep(state.step); } catch { /* campi non ancora montati */ }
    if (state.step === 4 || state.step === 5) loadPreview();
  }, 400);
});

// La tendina del canale serve solo quando i messaggi vanno in un canale solo.
document.addEventListener('change', (event) => {
  if (event.target?.name !== 'msg-target') return;
  const select = $('#message-channel');
  if (select) select.hidden = event.target.value !== 'one';
});

document.addEventListener('change', async (event) => {
  if (event.target.id !== 'import-file') return;
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    await api('/import', { method: 'POST', body: { config: JSON.parse(text) } });
    await refresh();
    state.draft = makeDraft(state.data.config);
    toast('Configurazione importata.', 'success');
  } catch (error) {
    toast(`Import non riuscito: ${error.message}`, 'error');
  } finally {
    event.target.value = '';
  }
});

/* ---------------- Utility ---------------- */

function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function tickCountdown() {
  const element = $('#countdown');
  if (!element) return;
  const runtime = state.data?.runtime;
  const fill = $('#countdown-fill');
  if (!runtime?.running || !runtime.nextAt) {
    element.textContent = '—';
    if (fill) fill.style.width = '0%';
    return;
  }
  const remaining = runtime.nextAt - Date.now();
  element.textContent = formatClock(remaining);
  if (fill) {
    const total = Math.max(30_000, (runtime.intervalSec ?? 300) * 1000);
    fill.style.width = `${Math.min(100, Math.max(0, (1 - remaining / total) * 100))}%`;
  }
}

setInterval(tickCountdown, 250);
boot();
