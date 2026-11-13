# Restream roadmap

Opgesteld 2026-11-12. De bewerkbare versie staat in het projectdocument; dit is de kopie in de repo.

## Doel en scope

Restream is een zelf gehoste multiplexer op Debian 13. Je stuurt er één stream naartoe (RTMP of SRT) en Restream verdeelt die met één klik op Go Live over YouTube, Facebook, Instagram, Twitch, X, LinkedIn, Kick en eigen RTMP- of SRT-servers.

Wel: ingest met streamkey, live dashboard met preview, outputs per stream met eigen bitrate, Go Live/Stop, live events plannen bij de platforms, opnameknop, live kijkersaantallen, samengevoegde chat, loginpagina als startpagina.

Ook: de stream zelf aanbieden als hotlink (HLS/WebRTC-URL) en als embed-speler voor websites.

Niet: VOD-hosting, video bewerken.

## Fases en prioriteiten

Fase 0 t/m 2 vormen samen v1.0. Elke fase gaat eerst naar `test` en pas na akkoord naar `main`.

### Fase 0 · Fundament (P0)
- Repo met `main` (productie) en `test`, huisstijl in de repo, installer voor een kale Debian 13-server (één script, geen Docker)
- Login met 2FA, gebruikers en rollen, adminpaneel met menu links
- Engels en Nederlands vanaf dag één, Info-knop met versienummer

### Fase 1 · Kern: restreamen (MVP, P0)
- Ingest via RTMP en SRT met instelbare streamkeys, dashboard met status en preview
- Outputs met streamkey: YouTube, Facebook, Twitch, eigen RTMP- en SRT-servers
- Go Live en Stop per stream en per output, bitrate per bestemming, automatisch herverbinden
- Eigen afspeel-URL per stream (HLS en WebRTC) om te hotlinken

### Fase 2 · Vaste beheerfuncties (P0) · klaar op `test` (v1.0.0)
- Eigen SMTP-server instellen (TLS en STARTTLS), testmail en meldingen bij uitval
- Back-ups volledig en incrementeel naar ftp, ftps en scp, met restore vanaf de remote locatie
- Updatecheck en updaten vanuit de UI, wisselen tussen productie en test

**Gate: v1.0 in productie**

### Fase 3 · Opnemen, plannen en embedden (P1) · klaar op `test` (v1.1.0)
- Embed-speler met kopieerbare iframe-code, eigen huisstijl en optioneel alleen voor toegestane domeinen of met een token
- Opnameknop tijdens de uitzending, overzicht van opnames met download
- Accounts koppelen via OAuth (YouTube, Facebook, Twitch) naast losse streamkeys
- Live events plannen, automatisch aanmelden bij de platforms en op tijd live gaan

### Fase 4 · Statistieken en chat (P2) · klaar op `test` (v1.2.0)
- Live kijkersaantallen per platform en in totaal op het dashboard
- Samengevoegde chat van alle platforms in één venster
- Overzicht per uitzending achteraf: piek, gemiddelde en duur

### Fase 5 · Uitbreiden (P3) · klaar op `test` (v1.3.0)
- Meer platforms: Instagram, LinkedIn, Kick en X, met eigen presets per platform
- Reserve-ingest met automatische overname en een fallback-beeld bij uitval
- API en webhooks voor koppeling met andere projecten

### Fase 6 · Betrouwbaar uitzenden · klaar op `test` (v1.6.0)
- Gezondheidsmonitor: bitrate, beeldsnelheid, keyframes en fouten van de feed, snelheid en CPU per bestemming, CPU, upload en schijf van de server, met waarschuwingen op het dashboard, per mail en via webhooks
- Controle vóór Go Live: feed, keys, accounts, bereikbaarheid, platformlimieten, CPU, upload en schijf
- Titel, beschrijving en thumbnail in één keer naar YouTube, Facebook en Twitch, ook tijdens de uitzending

## Platforms

| Platform | Streamen | Event plannen | Kijkers live | Chat | Fase |
| --- | --- | --- | --- | --- | --- |
| YouTube | RTMP(S) of OAuth | Ja (Live API) | Ja | Ja | 1 / 3 / 4 |
| Facebook (pagina) | RTMPS of OAuth | Ja (Graph API) | Ja | Ja (reacties) | 1 / 3 / 4 |
| Twitch | RTMP | Alleen streamschema | Ja | Ja | 1 / 4 |
| Eigen RTMP / SRT | Ja | n.v.t. | Nee | Nee | 1 |
| Instagram | RTMPS, server-URL en key per uitzending, staand 9:16 | Nee | Nee | Nee | 5 |
| Kick | RTMPS met streamkey | Nee | Nee | Nee | 5 |
| LinkedIn Live | RTMP(S) per live evenement, na goedkeuring door LinkedIn | Nee | Nee | Nee | 5 |
| X | RTMP(S) via Media Studio Producer, key per uitzending | Nee | Nee | Nee | 5 |

Fase 5 voegt Instagram, Kick, X en LinkedIn toe met een streamkey (geen OAuth): kijkers, chat en events plannen zijn bij die platforms niet via een openbare API beschikbaar (X en Kick alleen beperkt of betaald, LinkedIn alleen voor goedgekeurde partners). Reservefeed, fallback-beeld, API-sleutels en webhooks staan in de README en in [API.md](API.md).

Fase 3 en 4 zijn gebouwd tegen YouTube Data API v3, Facebook Graph API v26.0 en Twitch Helix/IRC (gecontroleerd november 2026), maar nog niet met echte accounts getest. Kijkers en chat werken alleen voor bestemmingen via een gekoppeld account. YouTube-chat kost 5 quota-eenheden per opvraging; met de standaard 10 seconden is dat ongeveer 1.800 eenheden per uur uitzending (dagquotum 10.000).

## Open punten

- Huisstijl: nieuwe futuristische stijl (donker, cyaan) aangenomen, nog te bevestigen.
- Aantal gelijktijdige streams en outputs per stream (bepaalt serverspecificaties).
- Eén organisatie of meerdere klanten/zenders.
