# ☢️ Bot Nuke

Bot Discord per eventi, con dashboard web e configurazione guidata. Fa esattamente tre cose, in loop:

- **cambia i nomi dei canali** a rotazione;
- **rimescola l'ordine** dei canali;
- **ripete in chat** i messaggi che decidi tu dalla dashboard.

Pensato per girare su **UmbrelOS** (container singolo, dati su volume, dashboard dietro l'app proxy di Umbrel).

---

## Cosa c'è dentro

| | |
|---|---|
| **Motore a tick** | Ogni *tick* applica nomi, ordine e messaggi. Intervallo e jitter configurabili. |
| **Configurazione guidata** | Sei passi: token → server → canali → nomi/ordine → messaggi → tempi. |
| **Rate-limit aware** | Le azioni passano da un budget (2 modifiche per canale / 10 min). Se finisce, il bot rimanda senza 429. |
| **Dry run** | Simula tutto e logga cosa farebbe, senza toccare Discord. |
| **Snapshot + Panic** | Salva i nomi originali al primo avvio e li ripristina con un pulsante. |
| **Burst di messaggi** | N copie per tick o timer indipendente, spaziate automaticamente. |
| **Log live** | Stream SSE + log completo con filtri. |
| **Demo mode** | `MOCK_DISCORD=1` per provare tutto senza token né server. |

---

## Limiti di Discord (importante)

Discord non permette di rinominare un canale quanto vuoi. Il bot non aggira i limiti: li rispetta e mostra il budget residuo in dashboard.

| Azione | Limite reale | Come lo gestisce Bot Nuke |
|---|---|---|
| Nome canale | ~2 modifiche / 10 min **per canale** | Coda con finestra scorrevole; le azioni oltre budget vengono rimandate al tick successivo |
| Ordine canali | ~2 riordini / 10 min **per server** | Stesso meccanismo, separato |
| Messaggi | ~5 / 5 s **per canale** | I burst vengono spalmati (attesa minima 300 ms tra le copie) |
| Sicurezza account | 10.000 richieste non valide / 10 min = ban 24 h | Il bot non forza mai i 429: li intercetta e mette in pausa la chiave |

Conseguenza pratica: con **intervallo 300 s** ogni canale viene rinominato 2 volte ogni 10 minuti, cioè al limite massimo consentito. Sotto i 300 s alcune rinomine verranno rimandate. La dashboard lo calcola e lo mostra al passo 6.

---

## Avvio rapido con Docker

```bash
git clone https://github.com/danyx67800/Bot_nuke.git
cd Bot_nuke
docker compose up -d --build
```

Apri `http://localhost:4321`, imposta la password della dashboard e segui i sei passi. I dati finiscono in `./data`.

## Installazione su UmbrelOS

Il repository è anche un **community app store** di Umbrel (`umbrel-app-store.yml` + `bot-nuke/umbrel-app.yml`).

1. Su Umbrel apri **App Store → … → Community App Stores**.
2. Aggiungi l'URL: `https://github.com/Gigiomiccio425/Gigio-dany-appstore` (store **Gigio & Dany**).
3. Installa **Bot Nuke** e apri la dashboard dalla home di Umbrel.

Questo repository è a sua volta uno store autonomo (`https://github.com/danyx67800/Bot_nuke`), utile solo se vuoi installare l'app da sola.

L'app usa l'immagine `ghcr.io/danyx67800/bot-nuke:1.0.2`, costruita da GitHub Actions. I dati (config, token, sessioni) stanno in `${APP_DATA_DIR}/data` e sopravvivono a update e riavvii.

> Se il pull dell'immagine fallisce con *unauthorized*, apri GitHub → **Packages → bot-nuke → Package settings** e imposta la visibilità su **Public**.

### Installazione manuale su UmbrelOS (senza store)

```bash
# sulla macchina Umbrel, via SSH
mkdir -p ~/bot-nuke && cd ~/bot-nuke
curl -O https://raw.githubusercontent.com/danyx67800/Bot_nuke/main/docker-compose.yml
docker compose up -d --build
```

La dashboard sarà su `http://umbrel.local:4321`. In alternativa, aggiungi il servizio alla tua configurazione Docker esistente mantenendo il volume `/data`.

---

## Preparare il bot su Discord

1. Vai su [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**.
2. Sezione **Bot** → **Reset Token** → copia il token (lo incolli al passo 1, non serve `.env`).
3. Sezione **OAuth2 → URL Generator**: scope `bot` + `applications.commands`, permessi:
   - **Manage Channels** (obbligatorio: rinomina e riordina)
   - **View Channels**
   - **Send Messages**
4. Invita il bot nel server con l'URL generato (la dashboard ha il pulsante "Copia link di invito" con i permessi già calcolati).
5. Metti il ruolo del bot **sopra** i canali che deve modificare, altrimenti Discord rifiuta le modifiche.

Il bot non usa intent privilegiati: solo `Guilds`.

---

## La dashboard

### Panoramica
Stato del loop, countdown del prossimo tick, anteprima di cosa cambierà, budget Discord per ogni canale e log degli ultimi eventi. Da qui: **Avvia**, **Ferma**, **Forza un tick**, **Panic** e invio immediato di messaggi.

### Configurazione (guidata)
1. **Bot** — incolla il token, verifica e connetti. Mostra tag, ID e avatar del bot.
2. **Server** — scegli il server tra quelli in cui il bot è presente, con i permessi mancanti evidenziati.
3. **Canali** — seleziona i canali da animare (raggruppati per categoria) e il canale dei messaggi.
4. **Nomi e ordine** — un nome per riga per ogni canale, rotazione dell'ordine (`0, 1, 2` = fermo, +1, +2) e anteprima dei prossimi 6 tick.
5. **Messaggi** — testi (uno per riga, ruotano), copie per burst, attesa, timer indipendente, menzioni.
6. **Tempi e avvio** — intervallo, jitter, dry run, riavvio automatico, avvio immediato, con il calcolo del budget.

### Attività
Log completo (fino a 500 eventi) con filtri per livello.

### Impostazioni
Sostituzione token, snapshot/ripristino, cambio password, export/import della configurazione (senza segreti), riepilogo limiti.

---

## Template supportati

In nomi canale e messaggi:

| Template | Risultato |
|---|---|
| `{n}` | numero del tick (1, 2, 3…) |
| `{tick}` | indice del tick (0, 1, 2…) |
| `{time}` | ora corrente `HH:MM` |
| `{date}` | data corrente `GG/MM` |
| `{rand:🔥\|💥\|⚡}` | una delle alternative a caso |

Esempio: `🔥-hype-{n}` → `🔥-hype-1`, poi `🔥-hype-2`, ecc.

> Discord normalizza i canali testuali: minuscole e spazi → trattini. Il bot confronta il nome normalizzato e **non** consuma budget se il nome è già quello giusto.

---

## Variabili d'ambiente

| Variabile | Default | Descrizione |
|---|---|---|
| `PORT` | `4321` | Porta HTTP della dashboard |
| `DATA_DIR` | `./data` | Cartella persistente (config + chiave sessioni) |
| `DISCORD_TOKEN` | — | Alternativa al token inserito dalla dashboard |
| `DASHBOARD_PASSWORD` | — | Password iniziale (solo al primo avvio) |
| `COOKIE_SECURE` | `0` | `1` se servi la dashboard in HTTPS |
| `PUBLIC_ORIGIN` | — | Origini extra consentite per le richieste POST (separate da virgola) |
| `TZ` | `Europe/Rome` | Fuso orario dei template `{time}` / `{date}` |
| `MOCK_DISCORD` | `0` | `1` = Discord simulato (demo) |

---

## Sicurezza e dati

- La dashboard richiede una password (hash **scrypt**, sessione firmata HMAC, cookie `HttpOnly` + `SameSite=Lax`).
- Cambiare password invalida tutte le sessioni esistenti.
- Login limitato a 6 tentativi ogni 5 minuti per IP.
- Le mutazioni rifiutano origini diverse da quella della dashboard (CSRF).
- Il **token del bot** è salvato in `data/config.json` con permessi `600`. Non viene mai restituito al browser (solo le ultime 4 cifre) e non finisce nei log.
- Nessun dato esce dal tuo server: il bot parla solo con l'API di Discord. La dashboard non carica risorse esterne.

Esponendo la dashboard su Internet, mettila dietro HTTPS (reverse proxy o Tailscale): è una console di controllo del tuo server Discord.

---

## Struttura del progetto

```
src/
  index.js            avvio: store, auth, bot, motore, HTTP
  server.js           API JSON + SSE + statici
  config.js           schema, validazione, export
  store.js            persistenza JSON atomica
  auth.js             scrypt + sessioni firmate + throttle
  logger.js           log in memoria + eventi SSE
  bot/
    discord.js        adapter Discord (discord.js v14)
    mock.js           adapter demo
    rotation.js       motore del loop, coda, burst, ripristino
    frame.js          calcolo dello stato per tick (puro)
    limiter.js        finestra scorrevole per i rate limit
    channels.js       tipi canale + normalizzazione nomi
    render.js         template {n}, {time}, {rand:…}
public/               dashboard (HTML/CSS/JS, nessun build)
bot-nuke/             pacchetto app UmbrelOS
test/                 test del motore (node:test)
```

---

## Sviluppo

```bash
npm install
npm run dev      # http://localhost:4321
npm run demo     # Discord simulato, dati in ./data-demo
npm test         # test di limiter, frame, template, validazione
```

Modalità demo: nessun token, un server finto con canali testuali e vocali. Utile per provare la configurazione e vedere il loop girare davvero (dry run disattivabile) senza rovinare un server reale.

---

## Pubblicare una nuova versione

```bash
git tag v1.0.0 && git push --tags
```

GitHub Actions costruisce l'immagine multi-arch (`amd64` + `arm64`) e la pubblica su GHCR. Poi aggiorna `version` in `bot-nuke/umbrel-app.yml` e il tag in `bot-nuke/docker-compose.yml`: Umbrel proporrà l'update.

---

## Problemi comuni

| Sintomo | Causa / soluzione |
|---|---|
| `50001 Missing Access` o rinomina fallita | Il bot non ha **Manage Channels**, o il suo ruolo è sotto il canale |
| Le rinomine si fermano | Budget Discord esaurito: la dashboard mostra il countdown per canale |
| Il bot non appare nel server | Usa il link di invito al passo 2 (scope `bot` + `applications.commands`) |
| La dashboard dice "bot offline" | Token errato o rete del container: riprova al passo 1 |
| "Too many attempts" al login | Attendi 5 minuti: protezione brute force |
| Dopo un update i canali restano com'erano | Comportamento voluto: il loop non riparte da solo se `autoStart` è off |

---

## Licenza

Uso personale per eventi. Fai quello che vuoi con il codice, ma non usare il bot per spam verso persone che non hanno acconsentito.
