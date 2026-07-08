# TrueSkill 1 vs. TrueSkill 2 – ausführlich erklärt

> Begleitdokument zum Implementationsplan in `docs/superpowers/plans/2026-05-28-trueskill2-upgrade.md`. Ein Glossar mit allen Fachbegriffen und Symbolen befindet sich am Ende.

---

## Inhaltsverzeichnis

1. [Was berechnet TrueSkill überhaupt?](#1-was-berechnet-trueskill-überhaupt)
2. [TrueSkill 1 (Herbrich, Minka, Graepel 2007)](#2-trueskill-1-herbrich-minka-graepel-2007)
3. [TrueSkill 2 – die fünf Modelländerungen](#3-trueskill-2--die-fünf-modelländerungen)
4. [Parameterschätzung – von Handarbeit zu Rprop](#4-parameterschätzung--von-handarbeit-zu-rprop-sektion-4)
5. [Online vs. Batch](#5-online-vs-batch-sektion-3)
6. [Wie kombiniert man Faktormessages technisch?](#6-wie-kombiniert-man-faktormessages-technisch)
7. [Ergebnisse auf Halo 5](#7-ergebnisse-auf-halo-5)
8. [Was bedeutet das für unser Repo?](#8-was-bedeutet-das-für-unser-repo)
9. [Glossar](#glossar)

---

## 1. Was berechnet TrueSkill überhaupt?

TrueSkill ist ein **bayessches** Bewertungssystem. Statt jedem Spieler eine einzelne Zahl zuzuweisen, modelliert es jeden Spieler als **Wahrscheinlichkeitsverteilung** über seine "wahre Spielstärke" – konkret eine Gaußverteilung mit Mittelwert μ und Standardabweichung σ:

```
skill_i ~ N(μ_i, σ_i²)
```

- **μ** ist der erwartete Skill.
- **σ** misst die verbleibende Unsicherheit. Anfänglich groß (8.33 bei μ₀=25), sinkt mit jedem Match.

Aus jedem Match-Ergebnis wird per Bayes-Regel ein neuer Posterior berechnet:

```
p(skill | Ergebnis) ∝ p(Ergebnis | skill) · p(skill)
```

Das Problem: Der exakte Posterior ist **nicht** mehr gaußisch, weil das Match-Ergebnis durch eine Indikatorfunktion ("Team 1 hat gewonnen") modelliert wird. Beide TrueSkill-Versionen lösen das mit **Expectation Propagation (EP)** – sie projizieren den Posterior in jeder Iteration zurück auf die beste gaußsche Annäherung.

---

## 2. TrueSkill 1 (Herbrich, Minka, Graepel 2007)

### 2.1 Das generative Modell

Ein Match entsteht in folgendem Erzeugungsprozess:

1. Jeder Spieler bekommt einen latenten Skill aus N(μ_i, σ_i²).
2. Für **dieses** Match zieht jeder Spieler eine **Performance**:

   ```
   perf_i ~ N(skill_i, β²)
   ```

   β bestimmt, wie viel Zufall pro Match in der Leistung steckt (im Repo: β = 25/6 ≈ 4.17).

3. Die **Teamperformance** ist die spielzeit-gewichtete Summe der Einzelperformances:

   ```
   perf_team = Σ_i (timePlayed_i / L) · perf_i
   ```

4. Das Team mit der höheren Performance gewinnt. Wenn der Abstand kleiner ε ist, ist es ein **Draw**.

Wichtig: zwischen Matches kann sich der Skill leicht ändern – das wird durch eine **unverzerrte Zufallsbewegung** modelliert:

```
skill^{t+L} ~ N(skill^t, γ²)           (Änderung durch Spielen)
skill^{t'}  ~ N(skill^t, τ²(t'−t))     (Änderung durch Zeitablauf)
```

### 2.2 Die geschlossene EP-Formel für 2 Teams

Für zwei Teams gibt es eine elegante geschlossene Form (genau das, was im Repo in `elo-calculator.js` implementiert ist):

```
c² = teamVar₁ + teamVar₂           (kombinierte Varianz, β² je Spieler eingerechnet)
t  = (teamμ₁ − teamμ₂) / c
v(t, ε/c) = φ(t−ε/c) / Φ(t−ε/c)    (für Sieg-Fall)
w(t, ε/c) = v · (v + t − ε/c)
```

Pro Spieler:

```
Δμ_i      = (σ_i² / c) · v
σ_i^neu²  = σ_i² · (1 − w · σ_i² / c²)   + τ²   (Dynamik-Rauschen)
```

Das ist **exakt** die EP-Projektion – nicht nur eine Heuristik.

### 2.3 Eigenschaften

- Benötigt nur Sieg / Niederlage / Unentschieden – keine Einzelstatistiken.
- Funktioniert für beliebig viele Teams beliebiger Größe.
- O(N_Spieler) pro Match. Sehr schnell.
- Skill-Rating ist eine einzelne Zahl (typisch μ − 3σ) → kompatibel mit klassischen Matchmaking-Systemen.

### 2.4 Was TrueSkill 1 systematisch falsch macht

Microsoft hat auf **23 Millionen Halo-5-Matches** trainiert und 3 Millionen testet. Dort sieht man die Schwächen sofort:

| Beobachtung | Tatsächliche Siegrate | v1-Vorhersage |
|---|---|---|
| 10er-Squad spielt zusammen | 89 % | **67 %** |
| Neuer Spieler (0 Matches) | 45 % | **49 %** |
| Spieler mit 3.6–4.0 K/min im Vorgängermatch | 59 % | **50 %** |
| Spieler hat letztes Match gequittet | 44 % | **47 %** |

Vier systematische Lücken. Klassisches TrueSkill erreicht damit **52 % Vorhersagegenauigkeit**. Reines Raten wäre 50 %.

---

## 3. TrueSkill 2 – die fünf Modelländerungen

Der Trick: das gaußsche generative Modell **bleibt**, aber es werden zusätzliche Faktoren in den Faktor-Graphen eingebaut – jeder schließt eine der oben genannten Lücken.

### 3.1 Squad-Offset (Sektion 6, Gl. 7)

Die Performance-Gleichung wird erweitert:

```
perf_i ~ N(skill_i + squadOffset(squadSize_i), β²)
```

`squadOffset` ist eine kalibrierte Tabelle pro Squad-Größe, mit `squadOffset(1) = 0` per Definition. Mathematisch nur eine **Mittelwert-Verschiebung** des Team-Mittels – die Varianz bleibt unverändert.

Auswirkung: ist ein Squad-Team Favorit, fällt der Rating-Gewinn bei Sieg **kleiner** aus, und der Rating-Verlust bei Niederlage **größer**. Damit korrigiert das System für die bekannte Tatsache, dass koordinierte Squads mehr leisten als die Summe ihrer Mitglieder.

### 3.2 Erfahrungs-Offset (Sektion 7, Gl. 8)

Die unverzerrte Zufallsbewegung wird durch eine **biased random walk** ersetzt:

```
skill^{t+L} ~ N(skill^t + experienceOffset(min(experience, 200)), γ²)
```

`experience` ist die bisher gespielte Match-Zahl, bei 200 gekappt. Die Tabelle hat 200 Einträge.

Operativ: nach **jedem** Match wird μ um `experienceOffset(experience)` erhöht – unabhängig vom Ausgang. Für Neulinge ist dieser Offset positiv (sie lernen schnell), für erfahrene Spieler nahe Null. Das erklärt, warum Anfänger in v1 systematisch unterschätzt wurden.

Subtile Eigenschaft: das Modell **belohnt nicht** die Anzahl gespielter Matches – der Offset ist viel kleiner als der Skill-Unterschied zwischen Sieg und Niederlage. Spieler müssen also weiterhin Matches gewinnen, um wirklich aufzusteigen.

### 3.3 Individuelle Statistiken: Kill / Death (Sektion 8, Gl. 9)

Pro Match wird zusätzlich beobachtet:

```
count_i^c ~ max(0, N((w_p^c · perf_i + w_o^c · perf_o_i) · tp_i, v^c · tp_i))
```

Mit c ∈ {kill, death}. Bedeutung der Parameter:

- **w_p^c**: Wie stark wirkt die eigene Performance auf die Statistik?
  - Kills: w_p > 0 (besserer Spieler ⇒ mehr Kills)
  - Tode: w_p < 0 (besserer Spieler ⇒ weniger Tode)
- **w_o^c**: Wie wirkt die Gegnerleistung?
  - Kills: w_o < 0 (stärkerer Gegner ⇒ weniger Kills)
  - Tode: w_o > 0 (stärkerer Gegner ⇒ mehr Tode)
- **tp_i**: gespielte Zeit – sowohl Mittelwert als auch Varianz skalieren linear damit.

Das `max(0, …)` ist eine **trunkierte Gaußverteilung** (Kills können nicht negativ sein). Für typische Match-Kills (>> 0) ist die Trunkierung jedoch irrelevant.

**Entscheidende Designentscheidung**: Das Modell sagt **zuerst** den Sieger voraus, **dann** erst die Einzelstatistiken. Der Skill ist nicht direkt mit Kills verknüpft, sondern über den Zwischenschritt "Performance". So bleibt das Skill-Rating ein Maß für Siegfähigkeit, nicht für Kill-Fähigkeit.

Das hat eine wichtige **Anreiz-Eigenschaft**: das Modell ist **monoton** in Kills – mehr Kills sind besser, aber nicht der einzige Weg, das Rating zu steigern. Spieler werden nicht dazu verleitet, das Team zu sabotieren, um persönliche Kills zu kriegen.

### 3.4 Quit-Penalty (Sektion 9, Gl. 12–13)

Wenn ein Spieler abbricht, kommt ein zusätzlicher Faktor hinzu:

```
under_i ~ N(perf_i − perf_o_i − m_q, v_q) < 0
quit_i  = unrelated_i  OR  (related_i  AND  under_i)
```

Interpretation:
- **under_i**: wahr, wenn die eigene Performance signifikant unter der Gegnerleistung liegt (Schwelle m_q ≤ 0)
- **unrelated_i**: Quit aus externen Gründen (Internet, etc.) – Wahrscheinlichkeit p_u
- **related_i**: Quit performance-bedingt – Wahrscheinlichkeit p_r

Beobachten wir `quit_i = true`, ist das Bayes-Evidenz dafür, dass `under_i` zutrifft → niedrige Performance → niedriger Skill.

**Subtilität, die das Paper ausdrücklich erwähnt**: um Quitter zu bestrafen, **muss das Modell gleichzeitig Vollender belohnen**. Sonst wäre Nicht-Quitten "neutral", und Quitten wäre keine sinnvolle Strafe relativ zum Erwarten. Deshalb kriegen Spieler, die zu Ende spielen, einen kleinen Bonus.

Für Online-Updates wird das vereinfacht: "Behandle den Quit wie ein zusätzliches Mini-Match, das der Quitter gegen das gegnerische Team verloren hat, mit Bonus-Margin m_q." Mathematisch ist das ein zweites, einseitiges TrueSkill-Update – dieselbe `v(t)`/`w(t)`-Maschinerie wie der Hauptfaktor.

### 3.5 Modus-Korrelation (Sektion 11)

Spieler haben in unterschiedlichen Spielmodi korrelierte Skills (gleiche Steuerung, Reflexe, Map-Kenntnis). TrueSkill 1 hält jeden Modus unabhängig. TrueSkill 2 zerlegt:

```
skill_id = w_d · base_i + offset_id
```

- **base_i**: gemeinsamer Basis-Skill, entwickelt sich über Zeit
- **offset_id**: modus-spezifischer Abstand
- **w_d ≥ 0**: gewichtet, wie stark der Modus mit dem Base korreliert

Spielt ein Spieler in Modus A, werden sowohl `offset_A` als auch `base` aktualisiert. Der `base` wirkt dann auf alle anderen Modi → **schnellere Konvergenz** bei Modus-Wechseln. Auf Halo 5 lag die Korrelation zwischen Modi bei 0.6 – signifikant.

Für **unser Squad-Plugin nicht relevant**: Squad hat keine wirklich getrennten Modi (AAS / Invasion / Skirmish unterscheiden sich kaum mechanisch).

---

## 4. Parameterschätzung – von Handarbeit zu Rprop (Sektion 4)

**TrueSkill 1**: Konstanten (β, τ, γ, ε) werden manuell gesetzt oder per Grid-Search optimiert. Im Repo etwa β = 25/6, τ = 0.25, ε implizit über `drawProbability = 0.01`.

**TrueSkill 2**: Die Parameter sind **Zufallsvariablen** mit breiten Priors und werden gemeinsam mit den Skills inferiert. Naive EP funktioniert hier nicht, weil jeder Parameter mit Millionen Faktoren verbunden ist (enormer Speicherbedarf, hochgradig nicht-gaußscher Posterior).

Lösung: **Rprop** (Riedmiller & Braun 1993).
1. Parameter werden als Punktschätzung behandelt (keine Verteilung).
2. Pro EP-Iteration werden Gradienten der Log-Likelihood akkumuliert.
3. Rprop aktualisiert die Parameter zwischen den EP-Sweeps.

Nach ca. 100 Vorwärts-/Rückwärts-Durchläufen konvergieren die Parameter. **Voraussetzung**: ≥ 1000 Matches pro Modus.

Für seltene Modi wird der populärste Modus als Fallback verwendet.

---

## 5. Online vs. Batch (Sektion 3)

Beide Versionen unterstützen zwei Inferenz-Modi:

| Modus | Funktion | Verwendung |
|---|---|---|
| **Online** | Match-für-Match-Update | Live-Matchmaking, niedrige Latenz |
| **Batch** ("TrueSkill Through Time") | Alle Matches gemeinsam | Saison-Reset, höhere Genauigkeit |

Im Paper-Beispiel (5 Matches zwischen 6 Spielern: A>B, C>D, E>F, B>C, D>E):
- Online: A, C, E haben am Ende denselben Skill; das System "sieht" nicht, dass A indirekt stärker ist als C.
- Batch: produziert die korrekte Ordnung A > B > C > D > E > F.

Microsofts Praxis: Online live, Batch vor Saisonstart über die gesamte Historie.

---

## 6. Wie kombiniert man Faktormessages technisch?

Der entscheidende mathematische Trick: **natürliche Parameterform** der Gaußverteilung:

```
Präzision        π = 1 / σ²
Präzision-Mittel τ = μ / σ²
```

In dieser Form ist Multiplikation von Gaußverteilungen **trivial**:

```
π_posterior  = π_prior  + Σ Δπ_factor
τ_posterior  = τ_prior  + Σ Δτ_factor

σ²_post = 1 / π_post
μ_post  = τ_post / π_post
```

In TrueSkill 1 gibt es **eine** Message: vom Team-Vergleich. In TrueSkill 2 können bis zu sechs zusammenkommen:

1. Team-Vergleich
2. Squad-Offset (modifiziert nur Mittelwert des Team-Faktors)
3. Erfahrungs-Offset (verschiebt μ nach dem Update)
4. Kill-Beobachtung
5. Death-Beobachtung
6. Quit-Faktor (nur wenn Quit beobachtet)

Alle werden in natürlicher Form addiert. Das ist genau das, was unser Plan im `elo-trueskill2-engine.js` orchestriert.

---

## 7. Ergebnisse auf Halo 5

| Modell | Vorhersagegenauigkeit |
|---|---|
| TrueSkill 1 | 52 % |
| TrueSkill 2 | 68 % |

**+16 Prozentpunkte** absolut, ~+30 % relativ. Pro Feature schließen sich die Vorhersage-Lücken:

| Effekt | v1 | v2 |
|---|---|---|
| Squad-Größe 10+: erwartete Siegrate vs. 89 % real | 67 % | 87 % |
| K/min 3.6–4.0: erwartete Siegrate vs. 59 % real | 50 % | 59 % |
| Neuer Spieler: erwartet vs. 45 % real | 49 % | 43 % |
| Win-Quit: erwartet vs. 45 % real | 49 % | 43 % |

Den **Großteil** der Verbesserung erklärt die Squad-Korrektur. Kills/Deaths, Erfahrung und Quits liefern jeweils 2–4 Prozentpunkte.

---

## 8. Was bedeutet das für unser Repo?

Aus den fünf v2-Features sind **vier direkt auf Squad anwendbar**:

| v2-Feature | Squad-Mapping | Status im Plan |
|---|---|---|
| Squad-Offset | In-Game-Squads (bis 9 Spieler) | Task 7 |
| Erfahrungs-Offset | Match-Count (`roundsPlayed`) | Task 8 |
| Quit-Penalty | Mid-Round-Disconnect via UPDATED_PLAYER_INFORMATION-Delta | Task 9 |
| Kill/Death | `PLAYER_DIED`-Events | Task 10 |
| Modus-Korrelation | **N/A** (Squad hat keine getrennten Modi) | bewusst weggelassen |

Außerdem brauchen wir **kein Infer.NET**. Microsoft generiert seinen EP-Code automatisch; wir müssen das nicht, weil:
- Squad hat immer **genau 2 Teams** → keine Free-for-All-Komplikation.
- Der Team-Vergleichsfaktor existiert bereits geschlossen in `elo-calculator.js`.
- Die vier neuen Faktoren sind alle entweder lineare gaußsche Beobachtungen (Kill/Death), einseitige Trunkierungen (Quit), oder reine Mittelwert-Verschiebungen (Squad/Erfahrung). Alle haben **geschlossene Formen**.

Wir erweitern also den bestehenden Closed-Form-Code um vier zusätzliche Faktor-Messages, kombiniert in natürlicher Parameterform – genau das, was `utils/elo-trueskill2-factors.js` und `utils/elo-trueskill2-engine.js` im Plan tun.

---

## Zusammenfassung in zwei Sätzen

**TrueSkill 1** ist ein sparsames bayessches Modell, das nur Sieg/Niederlage benutzt und systematisch die Effekte von Squads, Anfänger-Wachstum, individueller Leistung und Quit-Verhalten ignoriert. **TrueSkill 2** schließt diese vier Lücken durch zusätzliche gaußsche Faktoren im selben Erzeugungsmodell – die Inferenzmaschinerie (Expectation Propagation) bleibt identisch, nur das Faktormodell wird reicher.

---

# Glossar

Erklärungen für Fachbegriffe und Symbole, die in diesem Dokument auftauchen.

## Symbole

| Symbol | Aussprache | Bedeutung |
|---|---|---|
| **μ** | "mü" | Mittelwert einer Verteilung. In TrueSkill: der **erwartete Skill** eines Spielers. |
| **σ** | "sigma" (klein) | Standardabweichung. In TrueSkill: die **Unsicherheit** über den Skill. Je kleiner, desto sicherer das System. |
| **σ²** | "sigma quadrat" | Varianz – Standardabweichung im Quadrat. Mathematisch oft bequemer, aber dieselbe Bedeutung wie σ. |
| **β** | "beta" | Performance-Rausch-Parameter: wie viel Zufall pro Match in der Leistung steckt. Im Repo: β ≈ 4.17. |
| **γ** | "gamma" | Dynamik-Parameter: wie stark sich der Skill durch das **Spielen** eines Matches ändert. |
| **τ** | "tau" | In TrueSkill: zeitlicher Dynamik-Parameter (Skill-Drift zwischen Matches). *Achtung*: in der natürlichen Parameterform wird τ auch für "Präzision-Mittel" benutzt – Kontext beachten. |
| **ε** | "epsilon" | Draw-Margin: wie nah müssen die Team-Leistungen sein, damit das Match als Unentschieden gilt. |
| **π** | "pi" | In TrueSkill 2: **Präzision** = 1/σ². Hat *nichts* mit der Kreiszahl π ≈ 3.14 zu tun. |
| **φ** | "phi" (klein) | Dichtefunktion der Standardnormalverteilung – die "Höhe" der Glockenkurve an einem Punkt. |
| **Φ** | "Phi" (groß) | Verteilungsfunktion der Standardnormalverteilung – die "Fläche links" unter der Glocke bis zu einem Punkt. Also die Wahrscheinlichkeit, dass eine standardnormalverteilte Zahl ≤ diesem Punkt ist. |
| **N(μ, σ²)** | "N von mü, sigma quadrat" | Eine Normalverteilung mit Mittelwert μ und Varianz σ². "X ~ N(0, 1)" heißt: "X ist standardnormalverteilt". |
| **~** | "ist verteilt nach" | Mathematisches Symbol. "X ~ N(0, 1)" liest sich als "X ist verteilt nach der Standardnormalverteilung". |
| **∝** | "proportional zu" | "y ∝ x" heißt: y = konstanter Faktor · x. Die Konstante interessiert oft nicht. |
| **Σ** | "Sigma" (groß) | Summenzeichen. "Σ_i x_i" bedeutet: "Summiere alle x_i auf". |
| **∈** | "ist Element von" | Mengenzugehörigkeit. "c ∈ {kill, death}" heißt: c ist entweder "kill" oder "death". |
| **p(A\|B)** | "p von A gegeben B" | Bedingte Wahrscheinlichkeit von A, gegeben dass B passiert ist. |
| **Δ** | "Delta" | Eine Änderung. "Δμ" heißt "Änderung von μ". |

---

## Begriffe (alphabetisch)

### Anreiz / Incentive
Was Spieler motiviert. Wichtig beim Skill-System: keine schlechten Anreize schaffen – z.B. darf sich für einen Spieler nicht lohnen, das eigene Team zu sabotieren, um persönliche Statistiken zu verbessern.

### A-posteriori-Verteilung (Posterior)
Was wir **nach** einer Beobachtung über eine Größe glauben. In TrueSkill: nach 100 Matches wissen wir den Skill viel genauer als am Anfang.

### A-priori-Verteilung (Prior)
Was wir **vor** einer Beobachtung über eine Größe glauben. In TrueSkill: "Neue Spieler haben wahrscheinlich Skill nahe 25 mit großer Unsicherheit."

### Backpropagation
Ein numerisches Verfahren, um Gradienten in komplexen Modellen rückwärts durch die Berechnung zu transportieren. Standard im maschinellen Lernen.

### Batch-Inferenz
Alle Matches werden **gemeinsam** verarbeitet, nicht eines nach dem anderen. Genauer, aber rechenintensiver. Siehe auch *TrueSkill Through Time*.

### Bayessche Inferenz / Bayes-Regel
Eine Methode, Unsicherheiten zu aktualisieren, wenn neue Daten beobachtet werden. Benannt nach Thomas Bayes (1701–1761). Die zentrale Formel verbindet Prior und Beobachtung zu einem Posterior:
`p(Skill | Ergebnis) ∝ p(Ergebnis | Skill) · p(Skill)`

### Bedingte Wahrscheinlichkeit p(A|B)
"Die Wahrscheinlichkeit von A, gegeben dass B passiert ist." Zum Beispiel: "Die Wahrscheinlichkeit zu gewinnen, gegeben dass der Skill = 30 ist."

### Biased Random Walk
Eine Zufallsbewegung mit eingebauter Tendenz in eine Richtung. In TrueSkill 2: neue Spieler haben eine eingebaute positive Drift, weil sie typischerweise besser werden.

### Closed-Form / Geschlossene Form
Eine Formel, die man direkt ausrechnen kann, ohne iterative Schleifen. Gegenteil: "muss numerisch approximiert werden."

### Cold Start
Das Problem, dass ein System wenig Information hat, wenn etwas neu ist – z.B. ein neuer Spieler oder ein neuer Spielmodus.

### CSR – Competitive Skill Rank
In Halo gängige Einzel-Zahl pro Spieler, aus μ und σ abgeleitet. Im Repo gilt: **CSR = μ − 3σ**. Konservative Schätzung des "wahren" Skills.

### Dichtefunktion (φ, PDF)
Die "Höhe" einer Wahrscheinlichkeitsverteilung an einem Punkt. Bei der Glockenkurve: wie hoch die Kurve dort liegt. **PDF = Probability Density Function**.

### Draw / Unentschieden
Match-Ausgang, bei dem die Team-Performances zu nah beieinander liegen (Abstand ≤ ε) und kein Sieger erklärt wird.

### Erwartungsausbreitung – siehe **Expectation Propagation**

### Expectation Propagation (EP)
Ein iteratives Verfahren in der bayesschen Statistik, das schwierige Posterior-Verteilungen durch eine einfachere Verteilung (meist Gauß) annähert. Funktioniert durch wiederholtes "Nachrichten-Senden" zwischen den Faktoren eines Modells.

### Faktor (im Kontext Faktor-Graph)
Eine probabilistische Beziehung zwischen Variablen. In TrueSkill: "Team A hat Team B besiegt" ist ein Faktor, der Skills aller Beteiligten verbindet.

### Faktor-Graph
Eine grafische Darstellung eines probabilistischen Modells. Knoten sind Variablen, Verbindungen sind Faktoren. Auf solchen Graphen läuft EP.

### Faktor-Message
In EP: eine Gauß-Nachricht, die ein Faktor an eine Variable sendet, um deren Posterior zu beeinflussen.

### FFA – Free-for-All
Spielmodus, bei dem jeder gegen jeden spielt (keine Teams). Im Squad-Spiel nicht vorhanden – nur 2 Teams.

### Gaußverteilung / Normalverteilung
Die berühmte "Glockenkurve" – die häufigste Verteilung in der Statistik. Wird durch zwei Zahlen beschrieben: Mittelwert (wo der Gipfel liegt) und Standardabweichung (wie breit die Glocke ist). Geschrieben N(μ, σ²).

### Generatives Modell
Ein Modell, das beschreibt, **wie** die beobachteten Daten erzeugt wurden – als zufälliger Prozess. In TrueSkill: "Spieler hat einen Skill, Skill erzeugt Performance, Performance erzeugt Match-Ergebnis."

### Glockenkurve – siehe **Gaußverteilung**

### Gradient
In der Mathematik: die Richtung des stärksten Anstiegs einer Funktion. Beim Optimieren von Parametern: zeigt, wie man die Parameter ändern muss, um etwas zu verbessern.

### Halo 5
Online-Multiplayer-Shooter von 343 Industries (2015). Microsoft trainierte TrueSkill 2 auf Halo-5-Match-Daten (23 Millionen Trainings-Matches).

### Indikatorfunktion
Eine Funktion, die 1 zurückgibt, wenn eine Bedingung wahr ist, sonst 0. In TrueSkill: "1, wenn Team 1 gewann; 0 sonst."

### Inferenz
Das Schlussfolgern unbekannter Größen aus beobachteten Daten. In TrueSkill: aus Match-Ergebnissen den wahren Skill erschließen.

### Infer.NET
Eine Microsoft-Forschungs-Bibliothek, die aus einer probabilistischen Modellbeschreibung automatisch EP-Inferenz-Code generiert. Wurde für TrueSkill 2 benutzt; **brauchen wir nicht**, weil unsere Faktoren geschlossene Formen haben.

### Kill-Rate
Anzahl Kills pro Minute. Ein Indikator für individuelle Schießfertigkeit.

### Latente Variable
Eine Größe, die nicht direkt beobachtet werden kann, sondern nur durch ihre Auswirkungen geschätzt wird. Beispiel: der "wahre Skill" eines Spielers – nie direkt sichtbar, nur durch Match-Ergebnisse erschließbar.

### Latenz
Zeitliche Verzögerung. Im Matchmaking-Kontext: wie schnell ein Update verfügbar sein muss.

### Linear-gaußsch
Eine Beobachtung der Form `y = a·x + b + Rauschen`, wobei das Rauschen gaußisch ist. Solche Beobachtungen haben einfache, geschlossene EP-Messages.

### Log-Likelihood
Der Logarithmus der Wahrscheinlichkeit der beobachteten Daten unter dem Modell. Wird beim Lernen maximiert.

### Marginalisierung
In der Wahrscheinlichkeitsrechnung das "Wegintegrieren" einer Variablen – das Resultat ist die Verteilung über eine andere Variable, ohne die ausintegrierte zu berücksichtigen.

### Matchmaking
Der Prozess, ähnlich starke Spieler in dasselbe Match zu setzen. Braucht ein Skill-Rating als Eingabe.

### Mittelwert (μ)
Der durchschnittliche oder erwartete Wert einer Größe. Bei der Glockenkurve: die Mitte. In TrueSkill: das erwartete Können eines Spielers.

### Monoton
Eine Funktion ist monoton steigend, wenn größere Eingaben immer mindestens denselben oder größere Ausgaben ergeben. In TrueSkill 2: das Kill-Modell ist monoton – mehr Kills führen nie zu **weniger** Skill.

### Natürliche Parameterform (einer Gaußverteilung)
Die Darstellung einer Gaußverteilung durch **Präzision** π = 1/σ² und **Präzision-Mittel** τ = μ/σ². Vorteil: die Multiplikation zweier Gaußverteilungen ist hier nur eine Addition von π und τ. Genau das macht EP effizient.

### Online-Update
Skills werden Match-für-Match aktualisiert, jeweils basierend nur auf dem aktuellen Match. Schnell – richtig für Live-Matchmaking.

### O(N)
Notation für Rechenaufwand. "O(N)" heißt: der Aufwand wächst linear mit der Eingabegröße N. "O(N²)" wäre quadratisch usw.

### ORM – Object-Relational Mapping
Eine Bibliothek, die Datenbank-Tabellen als programmatische Objekte zugänglich macht. Im Repo: **Sequelize**.

### Performance (perf_i)
In TrueSkill: die tatsächliche Leistung eines Spielers in einem konkreten Match. Hängt vom Skill ab, hat aber auch eine Zufalls-Komponente (Streuung β).

### Posterior – siehe **A-posteriori-Verteilung**

### Präzision (π)
In der Statistik: der Kehrwert der Varianz, π = 1/σ². Hohe Präzision = niedrige Unsicherheit = schmale Verteilung. Mathematisch oft bequemer als die Varianz.

### Predictive Accuracy / Vorhersagegenauigkeit
Prozent der Matches, bei denen das Modell den richtigen Sieger vorhersagt. Reines Raten gibt 50 % (bei 2 Teams). TrueSkill 1 erreicht 52 % auf Halo 5, TrueSkill 2 erreicht 68 %.

### Prior – siehe **A-priori-Verteilung**

### Punktschätzung
Statt eine ganze Verteilung zu speichern, nur einen einzelnen "besten" Wert benutzen. Schneller, aber verliert Unsicherheits-Information. In TrueSkill 2 wird das für die Modellparameter (β, γ etc.) gemacht, *nicht* für die Spieler-Skills.

### Quit / Quitter
Ein Spieler, der ein Match vorzeitig verlässt. TrueSkill 2 fügt eine Penalty für Quitter hinzu (Sektion 9).

### Random Walk – siehe **Zufallsbewegung**

### Rating
Die Skill-Bewertung eines Spielers. Im Repo das Paar (μ, σ) oder die daraus abgeleitete einzelne Zahl (z.B. CSR).

### RCON
Ein Protokoll, mit dem Server-Admins per Netzwerk Befehle an einen Spiele-Server senden können. SquadJS nutzt RCON, um Spielerlisten und Events abzufragen.

### Rprop (Resilient Backpropagation)
Ein Optimierungsverfahren (Riedmiller & Braun 1993), das Schrittweiten dynamisch an die Stärke des Gradienten anpasst. Schneller als einfacher Gradientenabstieg.

### Sequelize
Ein **ORM** für Node.js, das viele Datenbanken (SQLite, MySQL, PostgreSQL) gleich zugänglich macht. Im Repo verwendet.

### Sigma – siehe σ in der Symboltabelle

### Skill (latente Variable)
In TrueSkill: die wahre, unbeobachtbare Spielstärke eines Spielers. Wird nie direkt gemessen, sondern aus Match-Ergebnissen geschätzt.

### Squad
Zwei verschiedene Bedeutungen, je nach Kontext:
- **Im TrueSkill-Paper / in Halo**: eine Gruppe von Freunden, die zusammen in die Warteschlange gehen.
- **Im Spiel "Squad"**: eine Truppe innerhalb eines Teams, organisiert über ein Squad-Lead-System. Bis zu 9 Spieler.

In unserem Plugin meinen wir die zweite Bedeutung, wenden aber die Squad-Offset-Idee genauso an.

### SquadJS
Eine Node.js-Plattform für Squad-Server-Plugins. Bietet Events (NEW_GAME, PLAYER_DIED, …) und RCON-Abstraktion. Dieses ELO-Tracker-Repo ist ein SquadJS-Plugin.

### Standardabweichung (σ)
Ein Maß für die Streuung einer Verteilung. Bei der Glockenkurve: die Breite. Wenn σ doppelt so groß wird, wird die Glocke doppelt so breit.

### Standardnormalverteilung
Die Gaußverteilung mit Mittelwert 0 und Standardabweichung 1: N(0, 1). Ihre Dichtefunktion ist φ, ihre Verteilungsfunktion ist Φ.

### TrueSkill / TrueSkill 2
Bayessche Skill-Rating-Systeme von Microsoft Research.
- **TrueSkill (2007)**: Herbrich, Minka, Graepel. Nutzt nur Sieg/Niederlage/Unentschieden.
- **TrueSkill 2 (2018)**: Minka, Cleven, Zaykov. Erweitert um Squad-Effekte, Erfahrung, Kills/Deaths, Quit-Penalty, Modus-Korrelation.

### TrueSkill Through Time
Der Batch-Inferenz-Modus von TrueSkill: alle Matches werden gemeinsam ausgewertet. Liefert genauere, geglättete Skill-Verläufe – auf Kosten höherer Rechenzeit.

### Trunkierte Gaußverteilung
Eine Gaußverteilung, deren Werte auf einen bestimmten Bereich beschränkt sind. In TrueSkill 2 z.B. für Kills (≥ 0) verwendet: man "schneidet" die Verteilung links bei 0 ab und normalisiert neu.

### Varianz (σ²)
Standardabweichung im Quadrat. Mathematisch oft bequemer, aber dieselbe Bedeutung – ein Maß für Streuung.

### Verteilungsfunktion (Φ, CDF)
Die "kumulierte" Wahrscheinlichkeit bis zu einem Punkt. Φ(x) ist die Fläche links unter der Glockenkurve bis x – also die Wahrscheinlichkeit, einen Wert ≤ x zu sehen. **CDF = Cumulative Distribution Function**.

### Wahrscheinlichkeitsverteilung
Eine mathematische Beschreibung, wie wahrscheinlich verschiedene Werte einer zufälligen Größe sind. Beispiel: "Die Körpergröße erwachsener Männer ist verteilt um 1,80 m mit Standardabweichung 8 cm."

### Zufallsbewegung (Random Walk)
Ein Prozess, bei dem sich eine Größe in jedem Zeitschritt zufällig ein bisschen ändert. In TrueSkill: zwischen Matches kann sich der wahre Skill leicht ändern – modelliert als kleiner gaußscher Schritt.
