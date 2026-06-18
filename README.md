# Velura — Eleganter Zufalls-Video-Chat (18+)

**Velura** ist eine eigenständige Web-App, die zwei zufällige Personen per
**WebRTC**-Videochat verbindet. Ein Klick auf **„Weiter"** trennt die
aktuelle Verbindung und sucht einen neuen Partner. Die Plattform ist
ausschließlich für **Erwachsene ab 18 Jahren** gedacht, **werbefrei** und
bringt von Anfang an Bausteine für verantwortungsvollen Betrieb mit:
Altersgate, optionaler Gast-Zugang, Melde-Funktion und Moderations-Backend.
Kamera und Mikrofon sind jederzeit **optional** ein- oder ausschaltbar.

Das Design ist bewusst **eigenständig** (eigene Marke, eigenes Logo, eigene
Farbwelt — keine OmeTV-Kopie), **dezent/seriös** und **vertrauensbildend**
(sichtbare Hinweise auf Jugendschutz, Regeln und die Melden-Funktion).

> ⚠️ **Wichtiger Hinweis:** Dies ist eine funktionsfähige Beispiel-/
> Demoanwendung, **kein produktionsreifes Produkt**. Vor einem echten Betrieb
> einer 18+-Plattform sind u. a. erforderlich: eine robuste
> **Altersverifikation** (Selbstauskunft genügt rechtlich meist nicht),
> **DSGVO-konformer** Datenschutz, aktive **Content-Moderation**, ein
> **TURN-Server** für zuverlässige Verbindungen, sowie die Einhaltung der
> jeweils geltenden Jugendschutz- und Medienrechtsvorschriften.

## Architektur

```
Browser (Client)                       Server (Node.js)
─────────────────                      ───────────────────────────
client/                                server/
  index.html   UI / Ansichten            index.js        HTTP + Static + WS
  css/         Styling                    config.js       Konfiguration / ICE
  js/app.js    Auth, WebRTC, Chat         db.js           node:sqlite Schema
                                          auth.js         scrypt + HMAC-Sessions
                                          routes.js       REST-API
                                          matchmaking.js  Queue + WS-Signaling
```

- **Matchmaking:** Wartende Nutzer landen in einer FIFO-Warteschlange und
  werden paarweise zu einem Raum verbunden. Einer der beiden ist „Initiator"
  und erstellt das WebRTC-Angebot.
- **Signaling:** Der Server leitet nur SDP-/ICE-Nachrichten und Text-Chat
  zwischen den Partnern weiter. Das Video läuft **peer-to-peer** (P2P).
- **Auth:** Passwörter mit `scrypt` gehasht, Sessions als HMAC-signierte
  Tokens (Cookie, `httpOnly`). Keine externen Krypto-Pakete.
- **Datenbank:** SQLite über das eingebaute `node:sqlite` (Node ≥ 22.5).

## Schnellstart

Voraussetzung: **Node.js ≥ 22.5**.

```bash
npm install
cp .env.example .env        # AUTH_SECRET anpassen!
npm start                   # http://localhost:3000
```

Während der Entwicklung mit Auto-Reload:

```bash
npm run dev
```

### Einen Moderator anlegen

Erst über die Web-Oberfläche registrieren, dann:

```bash
node --experimental-sqlite scripts/make-moderator.js <benutzername>
```

Danach erscheint der Button **„Moderation"** in der Kopfzeile, der offene
Meldungen anzeigt und das Sperren von Nutzern erlaubt.

## WebRTC & Netzwerk

Standardmäßig wird ein öffentlicher **STUN**-Server genutzt. In vielen
Netzen (striktes NAT, Firmen-Firewalls) kommt eine direkte P2P-Verbindung
nur über einen **TURN**-Server zustande. Trage diesen in der `.env` ein:

```
TURN_URL=turn:dein-turn-server:3478
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

Für **Kamera-/Mikrofonzugriff** im Browser ist außerhalb von `localhost`
zwingend **HTTPS** nötig. Hinter einem Reverse-Proxy (z. B. nginx, Caddy)
muss auch der WebSocket-Pfad `/ws` weitergereicht werden.

## Funktionsübersicht

- [x] Altersgate (18+-Bestätigung beim Betreten)
- [x] **Gast-Zugang ohne Konto** — nur Nickname wählen und loslegen
- [x] Optionale Registrierung mit Geburtsdatum + serverseitiger Altersprüfung
- [x] Login/Logout mit Session-Cookie
- [x] Zufalls-Matchmaking + WebRTC-Videochat (P2P)
- [x] „Start / Weiter / Stop"-Steuerung
- [x] **Kamera & Mikrofon optional** ein-/ausschaltbar (auch im Gespräch)
- [x] Begleitender Text-Chat
- [x] Nutzer melden (Meldungen landen in der DB)
- [x] Moderations-Backend (Meldungen ansehen, Nutzer sperren)
- [x] Eigenständiges, werbefreies Design mit eigenem Logo

## Mögliche nächste Schritte

- Echte Altersverifikation (z. B. Ident-Verfahren) statt Selbstauskunft
- Geschlechts-/Interessensfilter beim Matchmaking
- Rate-Limiting & Missbrauchsschutz (z. B. CAPTCHA, IP-Limits)
- Optionale serverseitige/automatisierte Inhaltsmoderation
- Eigener TURN-Server (coturn) und Deployment-Konfiguration
- Tests und CI
