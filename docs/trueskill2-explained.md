# TrueSkill 1 vs. TrueSkill 2 – explained in depth

---

## Table of contents

1. [What does TrueSkill actually compute?](#1-what-does-trueskill-actually-compute)
2. [TrueSkill 1 (Herbrich, Minka, Graepel 2007)](#2-trueskill-1-herbrich-minka-graepel-2007)
3. [TrueSkill 2 – the five model changes](#3-trueskill-2--the-five-model-changes)
4. [Parameter estimation – from hand-tuning to Rprop](#4-parameter-estimation--from-hand-tuning-to-rprop-section-4)
5. [Online vs. batch](#5-online-vs-batch-section-3)
6. [How are factor messages combined technically?](#6-how-are-factor-messages-combined-technically)
7. [Results on Halo 5](#7-results-on-halo-5)
8. [What does this mean for our repo?](#8-what-does-this-mean-for-our-repo)
9. [Glossary](#glossary)

---

## 1. What does TrueSkill actually compute?

TrueSkill is a **Bayesian** rating system. Instead of assigning each player a single number, it models every player as a **probability distribution** over their "true skill" – concretely a Gaussian distribution with mean μ and standard deviation σ:

```
skill_i ~ N(μ_i, σ_i²)
```

- **μ** is the expected skill.
- **σ** measures the remaining uncertainty. Initially large (8.33 at μ₀=25), it shrinks with every match.

From each match result, Bayes' rule computes a new posterior:

```
p(skill | result) ∝ p(result | skill) · p(skill)
```

The problem: the exact posterior is **no longer** Gaussian, because the match result is modelled by an indicator function ("team 1 won"). Both TrueSkill versions solve this with **Expectation Propagation (EP)** – in each iteration they project the posterior back onto the best Gaussian approximation.

---

## 2. TrueSkill 1 (Herbrich, Minka, Graepel 2007)

### 2.1 The generative model

A match arises from the following generative process:

1. Each player is given a latent skill drawn from N(μ_i, σ_i²).
2. For **this** match each player draws a **performance**:

   ```
   perf_i ~ N(skill_i, β²)
   ```

   β determines how much randomness enters the performance per match (in the repo: β = 25/6 ≈ 4.17).

3. The **team performance** is the play-time-weighted sum of the individual performances:

   ```
   perf_team = Σ_i (timePlayed_i / L) · perf_i
   ```

4. The team with the higher performance wins. If the gap is smaller than ε, it is a **draw**.

Important: between matches the skill can change slightly – this is modelled by an **unbiased random walk**:

```
skill^{t+L} ~ N(skill^t, γ²)           (change from playing)
skill^{t'}  ~ N(skill^t, τ²(t'−t))     (change from time passing)
```

### 2.2 The closed-form EP formula for 2 teams

For two teams there is an elegant closed form (exactly what is implemented in the repo in `elo-calculator.js`):

```
c² = teamVar₁ + teamVar₂           (combined variance, β² included per player)
t  = (teamμ₁ − teamμ₂) / c
v(t, ε/c) = φ(t−ε/c) / Φ(t−ε/c)    (for the win case)
w(t, ε/c) = v · (v + t − ε/c)
```

Per player:

```
Δμ_i      = (σ_i² / c) · v
σ_i^new²  = σ_i² · (1 − w · σ_i² / c²)   + τ²   (dynamics noise)
```

This is the **exact** EP projection – not merely a heuristic.

### 2.3 Properties

- Needs only win / loss / draw – no individual statistics.
- Works for any number of teams of any size.
- O(N_players) per match. Very fast.
- The skill rating is a single number (typically μ − 3σ) → compatible with classical matchmaking systems.

### 2.4 What TrueSkill 1 systematically gets wrong

Microsoft trained on **23 million Halo 5 matches** and tested on 3 million. There the weaknesses show up immediately:

| Observation | Actual win rate | v1 prediction |
|---|---|---|
| 10-player squad plays together | 89 % | **67 %** |
| New player (0 matches) | 45 % | **49 %** |
| Player with 3.6–4.0 K/min in the previous match | 59 % | **50 %** |
| Player quit their last match | 44 % | **47 %** |

Four systematic gaps. Classic TrueSkill reaches **52 % prediction accuracy** with this. Pure guessing would be 50 %.

---

## 3. TrueSkill 2 – the five model changes

The trick: the Gaussian generative model **stays**, but additional factors are built into the factor graph – each one closes one of the gaps named above.

### 3.1 Party offset (clan tag) (Section 6, Eq. 7)

The performance equation is extended:

```
perf_i ~ N(skill_i + partyOffset(partySize_i), β²)
```

where a "party" is a group of players sharing a **clan tag on the same team** (detected from their names, not from in-game squads). `partyOffset` is a calibrated table per party size, with `partyOffset(1) = 0` by definition. Mathematically it is only a **shift of the mean** of the team mean – the variance stays unchanged. Grouping is determined by clan-tag co-membership per team.

Effect: if a party team is the favourite, the rating gain on a win comes out **smaller**, and the rating loss on a defeat **larger**. This corrects for the well-known fact that coordinated parties achieve more than the sum of their members.

### 3.2 Experience offset (Section 7, Eq. 8)

The unbiased random walk is replaced by a **biased random walk**:

```
skill^{t+L} ~ N(skill^t + experienceOffset(min(experience, 200)), γ²)
```

`experience` is the number of matches played so far, capped at 200. The table has 200 entries.

Operationally: after **every** match μ is increased by `experienceOffset(experience)` – regardless of the outcome. For newcomers this offset is positive (they learn fast), for experienced players it is near zero. This explains why beginners were systematically underestimated in v1.

Subtle property: the model **does not reward** the number of matches played – the offset is far smaller than the skill difference between a win and a loss. So players still have to win matches to genuinely climb.

### 3.3 Individual statistics: kill / death (Section 8, Eq. 9)

Per match the following is additionally observed:

```
count_i^c ~ max(0, N((w_p^c · perf_i + w_o^c · perf_o_i) · tp_i, v^c · tp_i))
```

With c ∈ {kill, death}. Meaning of the parameters:

- **w_p^c**: how strongly does the player's own performance affect the statistic?
  - Kills: w_p > 0 (better player ⇒ more kills)
  - Deaths: w_p < 0 (better player ⇒ fewer deaths)
- **w_o^c**: how does the opponent's performance act?
  - Kills: w_o < 0 (stronger opponent ⇒ fewer kills)
  - Deaths: w_o > 0 (stronger opponent ⇒ more deaths)
- **tp_i**: time played – both mean and variance scale linearly with it.

The `max(0, …)` is a **truncated Gaussian** (kills cannot be negative). For typical match kill counts (>> 0) the truncation is however irrelevant.

**Crucial design decision**: the model predicts the winner **first**, and only **then** the individual statistics. Skill is not linked to kills directly, but through the intermediate step "performance". This keeps the skill rating a measure of the ability to win, not of the ability to get kills.

This has an important **incentive property**: the model is **monotone** in kills – more kills are better, but not the only way to raise the rating. Players are not tempted to sabotage the team in order to farm personal kills.

### 3.4 Quit penalty (Section 9, Eq. 12–13)

When a player quits, an additional factor is added:

```
under_i ~ N(perf_i − perf_o_i − m_q, v_q) < 0
quit_i  = unrelated_i  OR  (related_i  AND  under_i)
```

Interpretation:
- **under_i**: true when the player's own performance is significantly below the opponent's (threshold m_q ≤ 0)
- **unrelated_i**: a quit for external reasons (internet, etc.) – probability p_u
- **related_i**: a performance-related quit – probability p_r

Observing `quit_i = true` is Bayesian evidence that `under_i` holds → low performance → low skill.

**A subtlety the paper explicitly mentions**: to penalize quitters, the model **must simultaneously reward finishers**. Otherwise not quitting would be "neutral", and quitting would not be a meaningful penalty relative to expectation. That is why players who play to the end get a small bonus.

For online updates this is simplified: "Treat the quit like an extra mini-match that the quitter lost against the opposing team, with bonus margin m_q." Mathematically this is a second, one-sided TrueSkill update – the same `v(t)`/`w(t)` machinery as the main factor.

### 3.5 Mode correlation (Section 11)

Players have correlated skills across different game modes (same controls, reflexes, map knowledge). TrueSkill 1 keeps every mode independent. TrueSkill 2 decomposes:

```
skill_id = w_d · base_i + offset_id
```

- **base_i**: shared base skill, evolves over time
- **offset_id**: mode-specific offset
- **w_d ≥ 0**: weights how strongly the mode correlates with the base

When a player plays in mode A, both `offset_A` and `base` are updated. The `base` then acts on all other modes → **faster convergence** on mode switches. On Halo 5 the correlation between modes was 0.6 – significant.

**Not relevant for our Squad plugin**: Squad has no truly separate modes (AAS / Invasion / Skirmish barely differ mechanically).

---

## 4. Parameter estimation – from hand-tuning to Rprop (Section 4)

**TrueSkill 1**: the constants (β, τ, γ, ε) are set manually or optimized by grid search. In the repo roughly β = 25/6, τ = 0.25, ε implicitly via `drawProbability = 0.01`.

**TrueSkill 2**: the parameters are **random variables** with broad priors and are inferred jointly with the skills. Naive EP does not work here, because each parameter is connected to millions of factors (enormous memory demand, highly non-Gaussian posterior).

Solution: **Rprop** (Riedmiller & Braun 1993).
1. Parameters are treated as point estimates (no distribution).
2. Per EP iteration, gradients of the log-likelihood are accumulated.
3. Rprop updates the parameters between the EP sweeps.

After about 100 forward/backward passes the parameters converge. **Prerequisite**: ≥ 1000 matches per mode.

For rare modes the most popular mode is used as a fallback.

---

## 5. Online vs. batch (Section 3)

Both versions support two inference modes:

| Mode | Function | Use |
|---|---|---|
| **Online** | match-by-match update | live matchmaking, low latency |
| **Batch** ("TrueSkill Through Time") | all matches jointly | season reset, higher accuracy |

In the paper's example (5 matches between 6 players: A>B, C>D, E>F, B>C, D>E):
- Online: A, C, E end up with the same skill; the system does not "see" that A is indirectly stronger than C.
- Batch: produces the correct ordering A > B > C > D > E > F.

Microsoft's practice: online live, batch before the season start over the entire history.

---

## 6. How are factor messages combined technically?

The key mathematical trick: the **natural parameter form** of the Gaussian distribution:

```
precision       π = 1 / σ²
precision-mean  τ = μ / σ²
```

In this form multiplying Gaussians is **trivial**:

```
π_posterior  = π_prior  + Σ Δπ_factor
τ_posterior  = τ_prior  + Σ Δτ_factor

σ²_post = 1 / π_post
μ_post  = τ_post / π_post
```

In TrueSkill 1 there is **one** message: from the team comparison. In TrueSkill 2 up to six can come together:

1. team comparison
2. party offset (clan tag) (modifies only the mean of the team factor)
3. experience offset (shifts μ after the update)
4. kill observation
5. death observation
6. quit factor (only when a quit is observed)

All are added in natural form. This is exactly what our plan orchestrates in `elo-trueskill2-engine.js`.

---

## 7. Results on Halo 5

| Model | Prediction accuracy |
|---|---|
| TrueSkill 1 | 52 % |
| TrueSkill 2 | 68 % |

**+16 percentage points** absolute, ~+30 % relative. Per feature the prediction gaps close:

| Effect | v1 | v2 |
|---|---|---|
| Squad size 10+: expected win rate vs. 89 % real | 67 % | 87 % |
| K/min 3.6–4.0: expected win rate vs. 59 % real | 50 % | 59 % |
| New player: expected vs. 45 % real | 49 % | 43 % |
| Win-quit: expected vs. 45 % real | 49 % | 43 % |

The **majority** of the improvement is explained by the squad correction. Kills/deaths, experience and quits each contribute 2–4 percentage points.

---

## 8. What does this mean for our repo?

Of the five v2 features, **four are directly applicable to Squad**:

| v2 feature | Squad mapping | Status in the plan |
|---|---|---|
| Party offset (clan tag) | clan-tag co-membership on the same team | Task 7 |
| Experience offset | match count (`roundsPlayed`) | Task 8 |
| Quit penalty | mid-round disconnect via UPDATED_PLAYER_INFORMATION delta | Task 9 |
| Kill/death | `PLAYER_DIED` events | Task 10 |
| Mode correlation | **N/A** (Squad has no separate modes) | deliberately omitted |

We also need **no Infer.NET**. Microsoft generates its EP code automatically; we don't have to, because:
- Squad always has **exactly 2 teams** → no free-for-all complication.
- The team-comparison factor already exists in closed form in `elo-calculator.js`.
- The four new factors are all either linear Gaussian observations (kill/death), one-sided truncations (quit), or pure mean shifts (squad/experience). All have **closed forms**.

So we extend the existing closed-form code with four additional factor messages, combined in natural parameter form – exactly what `utils/elo-trueskill2-factors.js` and `utils/elo-trueskill2-engine.js` do in the plan.

---

## Summary in two sentences

**TrueSkill 1** is a parsimonious Bayesian model that uses only win/loss and systematically ignores the effects of squads, beginner growth, individual performance and quit behaviour. **TrueSkill 2** closes these four gaps through additional Gaussian factors in the same generative model – the inference machinery (Expectation Propagation) stays identical, only the factor model becomes richer.

---

# Glossary

Explanations for the technical terms and symbols that appear in this document.

## Symbols

| Symbol | Pronunciation | Meaning |
|---|---|---|
| **μ** | "mu" | Mean of a distribution. In TrueSkill: the **expected skill** of a player. |
| **σ** | "sigma" (lower case) | Standard deviation. In TrueSkill: the **uncertainty** about the skill. The smaller, the more certain the system. |
| **σ²** | "sigma squared" | Variance – standard deviation squared. Often more convenient mathematically, but the same meaning as σ. |
| **β** | "beta" | Performance-noise parameter: how much randomness enters the performance per match. In the repo: β ≈ 4.17. |
| **γ** | "gamma" | Dynamics parameter: how strongly the skill changes from **playing** a match. |
| **τ** | "tau" | In TrueSkill: the temporal dynamics parameter (skill drift between matches). *Note*: in the natural parameter form τ is also used for "precision-mean" – mind the context. |
| **ε** | "epsilon" | Draw margin: how close the team performances must be for the match to count as a draw. |
| **π** | "pi" | In TrueSkill 2: **precision** = 1/σ². Has *nothing* to do with the circle constant π ≈ 3.14. |
| **φ** | "phi" (lower case) | Density function of the standard normal distribution – the "height" of the bell curve at a point. |
| **Φ** | "Phi" (upper case) | Cumulative distribution function of the standard normal – the "area to the left" under the bell up to a point. That is, the probability that a standard-normal number is ≤ that point. |
| **N(μ, σ²)** | "N of mu, sigma squared" | A normal distribution with mean μ and variance σ². "X ~ N(0, 1)" means: "X is standard-normally distributed". |
| **~** | "is distributed as" | Mathematical symbol. "X ~ N(0, 1)" reads as "X is distributed according to the standard normal distribution". |
| **∝** | "proportional to" | "y ∝ x" means: y = constant factor · x. The constant is often of no interest. |
| **Σ** | "Sigma" (upper case) | Summation sign. "Σ_i x_i" means: "sum up all x_i". |
| **∈** | "is an element of" | Set membership. "c ∈ {kill, death}" means: c is either "kill" or "death". |
| **p(A\|B)** | "p of A given B" | Conditional probability of A, given that B has happened. |
| **Δ** | "Delta" | A change. "Δμ" means "change of μ". |

---

## Terms (alphabetical)

### A-posteriori distribution (posterior)
What we believe about a quantity **after** an observation. In TrueSkill: after 100 matches we know the skill far more precisely than at the start.

### A-priori distribution (prior)
What we believe about a quantity **before** an observation. In TrueSkill: "New players probably have a skill near 25 with large uncertainty."

### Backpropagation
A numerical method for transporting gradients backward through the computation in complex models. Standard in machine learning.

### Batch inference
All matches are processed **jointly**, not one after another. More accurate, but more compute-intensive. See also *TrueSkill Through Time*.

### Bayesian inference / Bayes' rule
A method for updating uncertainties when new data is observed. Named after Thomas Bayes (1701–1761). The central formula combines prior and observation into a posterior:
`p(skill | result) ∝ p(result | skill) · p(skill)`

### Biased random walk
A random walk with a built-in tendency in one direction. In TrueSkill 2: new players have a built-in positive drift, because they typically get better.

### Bell curve – see **Gaussian distribution**

### Closed form
A formula you can compute directly, without iterative loops. Opposite: "must be approximated numerically."

### Cold start
The problem that a system has little information when something is new – e.g. a new player or a new game mode.

### Conditional probability p(A|B)
"The probability of A, given that B has happened." For example: "The probability of winning, given that the skill = 30."

### CSR – Competitive Skill Rank
A single number per player common in Halo, derived from μ and σ. In the repo: **CSR = μ − 3σ**. A conservative estimate of the "true" skill.

### Density function (φ, PDF)
The "height" of a probability distribution at a point. For the bell curve: how high the curve sits there. **PDF = Probability Density Function**.

### Draw
A match outcome in which the team performances are too close together (gap ≤ ε) and no winner is declared.

### Expectation Propagation (EP)
An iterative method in Bayesian statistics that approximates difficult posterior distributions by a simpler distribution (usually Gaussian). It works by repeatedly "passing messages" between the factors of a model.

### Factor (in the factor-graph context)
A probabilistic relation between variables. In TrueSkill: "team A beat team B" is a factor that connects the skills of everyone involved.

### Factor graph
A graphical representation of a probabilistic model. Nodes are variables, edges are factors. EP runs on such graphs.

### Factor message
In EP: a Gaussian message that a factor sends to a variable in order to influence its posterior.

### FFA – Free-for-All
A game mode in which everyone plays against everyone (no teams). Not present in Squad – only 2 teams.

### Gaussian distribution / normal distribution
The famous "bell curve" – the most common distribution in statistics. Described by two numbers: the mean (where the peak lies) and the standard deviation (how wide the bell is). Written N(μ, σ²).

### Generative model
A model that describes **how** the observed data was generated – as a random process. In TrueSkill: "player has a skill, skill generates performance, performance generates the match result."

### Gradient
In mathematics: the direction of steepest increase of a function. When optimizing parameters: shows how the parameters must be changed to improve something.

### Halo 5
Online multiplayer shooter by 343 Industries (2015). Microsoft trained TrueSkill 2 on Halo 5 match data (23 million training matches).

### Incentive
What motivates players. Important for the skill system: create no bad incentives – e.g. it must never pay off for a player to sabotage their own team to improve personal statistics.

### Indicator function
A function that returns 1 when a condition is true, otherwise 0. In TrueSkill: "1 if team 1 won; 0 otherwise."

### Inference
Reasoning about unknown quantities from observed data. In TrueSkill: inferring the true skill from match results.

### Infer.NET
A Microsoft research library that automatically generates EP inference code from a probabilistic model description. It was used for TrueSkill 2; **we don't need it**, because our factors have closed forms.

### Kill rate
Number of kills per minute. An indicator of individual shooting skill.

### Latency
Time delay. In the matchmaking context: how quickly an update must be available.

### Latent variable
A quantity that cannot be observed directly but is only estimated through its effects. Example: the "true skill" of a player – never directly visible, only inferable through match results.

### Linear-Gaussian
An observation of the form `y = a·x + b + noise`, where the noise is Gaussian. Such observations have simple, closed-form EP messages.

### Log-likelihood
The logarithm of the probability of the observed data under the model. Maximized during learning.

### Marginalization
In probability theory, "integrating out" a variable – the result is the distribution over another variable, without regard to the one integrated out.

### Matchmaking
The process of putting similarly strong players into the same match. Needs a skill rating as input.

### Mean (μ)
The average or expected value of a quantity. For the bell curve: the centre. In TrueSkill: the expected ability of a player.

### Monotone
A function is monotonically increasing if larger inputs always yield the same or larger outputs. In TrueSkill 2: the kill model is monotone – more kills never lead to **less** skill.

### Natural parameter form (of a Gaussian)
The representation of a Gaussian by **precision** π = 1/σ² and **precision-mean** τ = μ/σ². Advantage: multiplying two Gaussians here is just an addition of π and τ. This is exactly what makes EP efficient.

### Normal distribution – see **Gaussian distribution**

### Online update
Skills are updated match by match, each time based only on the current match. Fast – right for live matchmaking.

### O(N)
Notation for computational cost. "O(N)" means: the cost grows linearly with the input size N. "O(N²)" would be quadratic, etc.

### ORM – Object-Relational Mapping
A library that makes database tables accessible as programmatic objects. In the repo: **Sequelize**.

### Performance (perf_i)
In TrueSkill: the actual performance of a player in a concrete match. Depends on the skill, but also has a random component (spread β).

### Point estimate
Instead of storing a whole distribution, use only a single "best" value. Faster, but loses uncertainty information. In TrueSkill 2 this is done for the model parameters (β, γ, etc.), *not* for the player skills.

### Posterior – see **A-posteriori distribution**

### Precision (π)
In statistics: the reciprocal of the variance, π = 1/σ². High precision = low uncertainty = narrow distribution. Often more convenient mathematically than the variance.

### Predictive accuracy
The percentage of matches in which the model predicts the correct winner. Pure guessing gives 50 % (with 2 teams). TrueSkill 1 reaches 52 % on Halo 5, TrueSkill 2 reaches 68 %.

### Prior – see **A-priori distribution**

### Probability distribution
A mathematical description of how likely different values of a random quantity are. Example: "The height of adult men is distributed around 1.80 m with a standard deviation of 8 cm."

### Quit / quitter
A player who leaves a match early. TrueSkill 2 adds a penalty for quitters (Section 9).

### Random walk
A process in which a quantity changes randomly a little at each time step. In TrueSkill: between matches the true skill can change slightly – modelled as a small Gaussian step.

### Rating
The skill assessment of a player. In the repo the pair (μ, σ) or the single number derived from it (e.g. CSR).

### RCON
A protocol with which server admins can send commands to a game server over the network. SquadJS uses RCON to query player lists and events.

### Rprop (Resilient Backpropagation)
An optimization method (Riedmiller & Braun 1993) that adapts step sizes dynamically to the strength of the gradient. Faster than plain gradient descent.

### Sequelize
An **ORM** for Node.js that makes many databases (SQLite, MySQL, PostgreSQL) equally accessible. Used in the repo.

### Skill (latent variable)
In TrueSkill: the true, unobservable playing strength of a player. Never measured directly, but estimated from match results.

### Squad
Two different meanings, depending on context:
- **In the TrueSkill paper / in Halo**: a group of friends who queue together.
- **In the game "Squad"**: a fireteam within a team, organized via a squad-lead system. Up to 9 players.

In our plugin we mean the second meaning, but apply the squad-offset idea in the same way.

### SquadJS
A Node.js platform for Squad server plugins. It provides events (NEW_GAME, PLAYER_DIED, …) and an RCON abstraction. This ELO-tracker repo is a SquadJS plugin.

### Standard deviation (σ)
A measure of the spread of a distribution. For the bell curve: the width. When σ doubles, the bell becomes twice as wide.

### Standard normal distribution
The Gaussian distribution with mean 0 and standard deviation 1: N(0, 1). Its density function is φ, its distribution function is Φ.

### Truncated Gaussian
A Gaussian distribution whose values are restricted to a certain range. In TrueSkill 2 used e.g. for kills (≥ 0): the distribution is "cut off" on the left at 0 and renormalized.

### TrueSkill / TrueSkill 2
Bayesian skill-rating systems by Microsoft Research.
- **TrueSkill (2007)**: Herbrich, Minka, Graepel. Uses only win/loss/draw.
- **TrueSkill 2 (2018)**: Minka, Cleven, Zaykov. Extended with squad effects, experience, kills/deaths, quit penalty, mode correlation.

**Primary source:** Minka, T., Cleven, R. & Zaykov, Y. (2018). *TrueSkill 2: An improved Bayesian skill rating system.* Microsoft Research Technical Report MSR-TR-2018-8. <https://www.microsoft.com/en-us/research/publication/trueskill-2-improved-bayesian-skill-rating-system/>
### TrueSkill Through Time
The batch-inference mode of TrueSkill: all matches are evaluated jointly. Yields more accurate, smoothed skill trajectories – at the cost of higher compute time.

### Variance (σ²)
Standard deviation squared. Often more convenient mathematically, but the same meaning – a measure of spread.

### Cumulative distribution function (Φ, CDF)
The "cumulative" probability up to a point. Φ(x) is the area to the left under the bell curve up to x – i.e. the probability of seeing a value ≤ x. **CDF = Cumulative Distribution Function**.
