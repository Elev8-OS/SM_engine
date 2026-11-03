# Instagram-Zahlen pro Beitrag und Anzeigen (Meta)

Der SM Manager zeigt im Tab "Kennzahlen" unter "Einzelne Beiträge", wie jeder Beitrag lief (Aufrufe, Reichweite,
Likes, Kommentare, Gespeichert, Geteilt, Interaktionsrate) und ordnet ihn unseren Beiträgen und den Klicks auf den
getrackten Link zu. Die Zahlen kommen direkt von Meta. Dieselbe Meta-App und dasselbe Token dienen später für Anzeigen.

| Variable (Railway, Dienst render-service) | Wert |
|---|---|
| `META_ACCESS_TOKEN` | Token des Systemnutzers "Elev8 Growth" (läuft nie ab) |
| `META_IG_USER_ID` | `17841462424236117` (Instagram-Konto `elevate_villas`, aus der GHL-Verbindung übernommen) |
| `META_GRAPH_VERSION` | optional, Standard `v22.0` |

## So wurde es eingerichtet

1. **Meta-App** "Elev8 Growth" auf developers.facebook.com, verbunden mit dem verifizierten Business-Portfolio
   "Elevate Investments". Anwendungsfälle: *Messaging und Content auf Instagram verwalten*, *Alles auf deiner Seite
   verwalten*, *Werbeanzeigen mit Marketing API erstellen und verwalten*. Die App bleibt im Entwicklungsmodus,
   eine App-Review ist nicht nötig, solange nur Personen mit einer Rolle in der App sie nutzen.
2. **Berechtigungen** unter *Anwendungsfall personalisieren* hinzugefügt: `instagram_basic`, `instagram_manage_insights`,
   `instagram_content_publish`, `instagram_manage_comments` (Instagram) sowie die schon vorhandenen
   `pages_show_list`, `pages_read_engagement`, `ads_management`, `ads_read`, `business_management`.
3. **Systemnutzer** "Elev8 Growth" im Business-Portfolio (*Einstellungen, Nutzer, Systemnutzer*), Mitarbeiter-Zugriff,
   mit den Assets: Facebook-Seite *Elevate Villas Bali*, Instagram-Konto `elevate_villas`, Werbekonto *Elevate Villas*.
   Der Systemnutzer ist der App unter *Konten, Apps* zugewiesen.
4. **Token** über *Systemnutzer, Elev8 Growth, Token generieren*: App *Elev8 Growth*, Ablauf *nie*, Berechtigungen
   `instagram_basic`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`, `read_insights`
   und für Anzeigen `ads_management`, `ads_read`, `business_management`.
   Meta verlangt dafür die **Genehmigung einer zweiten Person** mit Admin-Rechten im Portfolio (Vier-Augen-Prinzip,
   gültig 7 Tage). Danach zeigt Meta das Token **einmal** an. Direkt in Railway als `META_ACCESS_TOKEN` eintragen,
   niemals in Chats oder Tickets einfügen.
5. In Orbit unter *SM Manager, Kennzahlen* prüfen, ob "Einzelne Beiträge" gefüllt ist.

## Sicherheit

- Mit `ads_management` kann das Token Geld ausgeben. Im Werbekonto ein **Ausgabenlimit** setzen. Die Engine legt
  Kampagnen nur als pausierte Entwürfe an, aktiviert wird nach Freigabe in Orbit.
- Wird das Token ungültig oder widerrufen, zeigt der Tab eine Meldung und die zuletzt gespeicherten Zahlen.
  Dann ein neues Token erzeugen (Schritt 4) und in Railway ersetzen.
- Bestehende Systemnutzer im Portfolio (zum Beispiel "Elevate Villas Bali") nicht anfassen, sie gehören zu anderen
  Integrationen. Auf keinen Fall deren Tokens widerrufen.

## Ausweichweg (nur falls der Systemnutzer nicht geht)

Token im *Graph API Explorer* (<https://developers.facebook.com/tools/explorer>) mit den Rechten `instagram_basic`,
`instagram_manage_insights`, `pages_show_list`, `pages_read_engagement` erzeugen, im *Access Token Debugger*
(<https://developers.facebook.com/tools/debug/accesstoken>) mit *Extend Access Token* verlängern und dann mit
`me/accounts` das Token der Seite holen. Dieses Seiten-Token läuft nach Metas Beschreibung nicht ab, wenn es aus einem
langlebigen Token entsteht.

## Hinweise

- Die Zahlen werden höchstens stündlich bei Meta abgefragt und in der Tabelle `post_insights` gespeichert.
  Zuordnung zu unseren Beiträgen: Die Engine vergleicht den Anfang der Caption. Von Hand gepostete Beiträge erscheinen
  trotzdem, aber ohne Villa und Klicks.
- Hilfsaufruf: `GET /stats/meta/accounts` (mit `x-api-key`) zeigt die Seiten und Instagram-Konten, die das Token sieht.
- Kennzahlen (Stand Meta 2026): Aufrufe (`views`), Reichweite (`reach`), Gespeichert (`saved`), Geteilt (`shares`),
  Interaktionen (`total_interactions`), bei Reels zusätzlich die durchschnittliche Sehdauer.
  Je nach Beitragstyp liefert Meta nicht alle Kennzahlen. Fehlt eine, bleibt das Feld leer.
