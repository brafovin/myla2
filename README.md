# Velura — Eleganter Zufalls-Video-Chat (18+)

**Velura** verbindet zufällige Erwachsene per **WebRTC**-Videochat. Ein Klick
auf **„Weiter"** trennt und sucht einen neuen Partner. Werbefrei, ab 18,
mit Gast-Zugang, optionaler Kamera/Mikro, frei gestaltbaren Avataren,
Melde-Funktion und Moderation.

Es gibt **zwei Betriebsarten**:

1. **Serverlos: Vercel + Supabase** (empfohlen, kein eigener Server) — der
   statische Client wird auf Vercel gehostet, Supabase liefert Datenbank,
   Auth, Matchmaking und Realtime-Signaling.
2. **All-in-one: eigener Node-Server** (Ordner `server/`) — für lokale
   Entwicklung oder Hosting auf Render/Railway/Fly (siehe unten).

---

## Variante 1 — Vercel + Supabase (empfohlen)

### Überblick

```
Browser (statischer Client auf Vercel)        Supabase
────────────────────────────────────          ───────────────────────────
client/  (HTML/CSS/JS, supabase-js)   <──>     Postgres  (Profile, Reports)
  config.js   Projekt-URL + anon key           Auth      (anonym + E-Mail)
  js/app.js   Auth, Matchmaking, WebRTC         Realtime  (Signaling/Matches)
```

Das Video läuft **peer-to-peer**; Supabase übermittelt nur SDP/ICE/Chat.

### 1. Supabase-Projekt anlegen

1. Auf [supabase.com](https://supabase.com) ein neues Projekt erstellen.
2. **SQL Editor** öffnen, den Inhalt von
   [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql)
   einfügen und ausführen. Das legt Tabellen, Sicherheitsregeln (RLS),
   Matchmaking-Funktionen und Realtime an.
3. **Auth → Sign In / Providers**: **„Anonymous sign-ins" aktivieren**
   (für den Gast-Zugang). Für E-Mail-Konten ohne Bestätigungsmail kann
   „Confirm email" zum Testen deaktiviert werden.

### 2. Client konfigurieren

In [`client/config.js`](client/config.js) die beiden öffentlichen Werte aus
**Project Settings → API** eintragen:

```js
window.VELURA_CONFIG = {
  supabaseUrl: 'https://DEIN-PROJEKT.supabase.co',
  supabaseAnonKey: 'DEIN-ANON-PUBLIC-KEY',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
```

> Diese Werte sind **öffentlich** und dürfen committet werden — die Daten
> schützt die Row-Level-Security, nicht die Geheimhaltung des anon-Keys.

### 3. Auf Vercel deployen

- Repository in Vercel importieren.
- **Framework Preset: „Other"**, **Build Command: leer**,
  **Output Directory: `client`** (ist auch in `vercel.json` hinterlegt).
- Deployen. Fertig — die Seite lädt den Client statisch und spricht direkt
  mit Supabase.

### Moderator ernennen

Im Supabase **SQL Editor** (Nutzer muss sich vorher einmal angemeldet haben):

```sql
update public.profiles set is_moderator = true
where id = (select id from auth.users where email = 'deine@mail.de');
```

Danach erscheint der **„Moderation"**-Button in der Kopfzeile.

---

## Variante 2 — Eigener Node-Server (lokal / Render)

Der Ordner `server/` enthält eine eigenständige All-in-one-Version (Express +
WebSocket + SQLite), die **ohne Supabase** läuft. Gut für lokale Entwicklung
oder Hosting auf Plattformen mit dauerhaftem Prozess (Render/Railway/Fly).

> Hinweis: Diese Variante nutzt eine **eigene** Client-Logik-Erwartung
> (REST/WS). Der aktuelle `client/js/app.js` ist auf **Supabase** ausgelegt.
> Für den reinen Node-Betrieb müsste der Client wieder auf die `/api`- und
> `/ws`-Endpunkte zeigen. Die Server-Endpunkte sind weiterhin vorhanden und
> getestet.

```bash
npm install
cp .env.example .env      # AUTH_SECRET setzen
npm start                 # http://localhost:3000
```

---

## Funktionsübersicht

- [x] Altersgate (18+-Bestätigung beim Betreten)
- [x] **Gast-Zugang ohne Konto** (anonyme Anmeldung) + optionale E-Mail-Konten
- [x] Zufalls-Matchmaking + WebRTC-Videochat (P2P)
- [x] „Start / Weiter / Stop"-Steuerung
- [x] **Kamera & Mikrofon optional** ein-/ausschaltbar (auch im Gespräch)
- [x] **Frei gestaltbare Avatare** (Emoji/Symbol + Farbe), gezeigt bei Kamera aus
- [x] Begleitender Text-Chat
- [x] Nutzer melden + Moderations-Backend (Meldungen ansehen, Nutzer sperren)
- [x] Eigenständiges, werbefreies Design mit eigenem Logo

## Wichtiger Hinweis

Velura ist eine **Beispiel-/Demoanwendung**. Vor einem echten Betrieb einer
18+-Plattform sind u. a. erforderlich: **robuste Altersverifikation** (die
hiesige Selbstauskunft genügt rechtlich meist nicht), **DSGVO-konformer
Datenschutz**, aktive **Content-Moderation**, ein **TURN-Server** für
zuverlässige Verbindungen, sowie die Einhaltung der geltenden Jugendschutz-
und Medienrechtsvorschriften.

## Kamera/Mikro & Netzwerk

- Außerhalb von `localhost` ist für Kamera-/Mikrofonzugriff **HTTPS** nötig
  (Vercel liefert HTTPS automatisch).
- Für Verbindungen hinter striktem NAT wird ein **TURN-Server** benötigt
  (in `config.js` unter `iceServers` ergänzen).
