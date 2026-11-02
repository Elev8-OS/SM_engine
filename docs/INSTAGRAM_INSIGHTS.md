# Instagram-Zahlen pro Beitrag (Meta Graph API)

Der SM Manager zeigt im Tab "Kennzahlen" unter "Einzelne Beiträge", wie jeder Beitrag lief (Aufrufe, Reichweite,
Likes, Kommentare, Gespeichert, Geteilt, Interaktionsrate) und ordnet ihn unseren Beiträgen und den Klicks auf den
getrackten Link zu. Die Zahlen kommen direkt von Meta. Dafür braucht die Engine zwei Variablen:

| Variable | Wert |
|---|---|
| `META_ACCESS_TOKEN` | Zugriffs-Token einer Facebook-Seite (läuft nicht ab, wenn es aus einem langlebigen User-Token entsteht) |
| `META_IG_USER_ID` | Kennung des Instagram-Business-Kontos `elevate_villas` |

Optional: `META_GRAPH_VERSION` (Standard `v22.0`).

## Einrichtung (einmalig, ca. 20 Minuten)

Voraussetzung: `elevate_villas` ist ein Business-Konto und mit einer Facebook-Seite verknüpft. Das ist der Fall,
sonst würde die Verbindung zu GoHighLevel nicht funktionieren.

1. **Meta-App anlegen.** Auf <https://developers.facebook.com> unter *Meine Apps* eine neue App erstellen
   (Typ *Business*, Name zum Beispiel "R Villas Insights"). Mit dem Facebook-Konto anmelden, das die Seite verwaltet.
2. **Instagram-Produkt hinzufügen.** Im App-Dashboard das Produkt für die Instagram-Graph-API hinzufügen
   (je nach Oberfläche "Instagram", "Instagram API" oder "Instagram Graph API", die Variante mit Facebook-Login).
3. **Token erzeugen.** Im *Graph API Explorer* (<https://developers.facebook.com/tools/explorer>):
   - Oben rechts die neue App wählen, Typ *User Token*.
   - Berechtigungen hinzufügen: `instagram_basic`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`.
   - *Generate Access Token*, im Dialog die Seite und das Instagram-Konto `elevate_villas` auswählen und bestätigen.
4. **Langlebig machen.** Das Token im *Access Token Debugger* (<https://developers.facebook.com/tools/debug/accesstoken>)
   einfügen und unten *Extend Access Token* wählen. Das neue Token gilt 60 Tage.
5. **Seiten-Token holen.** Im Graph API Explorer mit dem langlebigen Token die Abfrage `me/accounts` ausführen.
   Beim Eintrag der Seite steht ein `access_token`. Dieses Seiten-Token läuft nicht ab. Es ist der Wert für `META_ACCESS_TOKEN`.
6. **In Railway eintragen** (Projekt SM_engine, Dienst render-service, Reiter Variables): `META_ACCESS_TOKEN`.
7. **Instagram-ID finden.** Mit gesetztem Token liefert die Engine unter `/stats/meta/accounts` (mit `x-api-key`)
   die Seiten und die zugehörige `instagram_id`. Diese als `META_IG_USER_ID` eintragen.
8. In Orbit unter *SM Manager, Kennzahlen* prüfen, ob die Tabelle gefüllt ist.

## Hinweise

- Solange die Meta-App im Entwicklungsmodus ist, funktioniert sie für Konten, bei denen du eine Rolle in der App hast.
  Für das eigene Konto ist keine App-Prüfung durch Meta nötig.
- Token niemals in Chats oder Tickets einfügen, nur direkt in Railway.
- Läuft das Token ab oder wird es widerrufen, zeigt der Tab eine Meldung und die zuletzt gespeicherten Zahlen.
  Dann Schritt 3 bis 6 wiederholen.
- Die Zahlen werden höchstens stündlich bei Meta abgefragt und in der Tabelle `post_insights` gespeichert.
  Zuordnung zu unseren Beiträgen: Die Engine vergleicht den Anfang der Caption. Von Hand gepostete Beiträge erscheinen
  trotzdem, aber ohne Villa und Klicks.
- Kennzahlen (Stand Meta 2026): Aufrufe (`views`), Reichweite (`reach`), Gespeichert (`saved`), Geteilt (`shares`),
  Interaktionen (`total_interactions`), bei Reels zusätzlich die durchschnittliche Sehdauer.
  Gelieferte Kennzahlen können sich je nach Beitragstyp unterscheiden. Fehlt eine, bleibt das Feld leer.
