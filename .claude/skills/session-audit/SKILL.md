---
name: session-audit
description: >-
  Audit the NEXT SESSION before it is played — read the live world's maps, placed monsters, and PC
  sheets, do the encounter arithmetic, and judge whether the fights are tuned right and whether the
  night actually fits in the hours available — then audit CAMPAIGN progress and pacing against the
  plot doc and the sessions played so far. Use when the user wants to "audit my next session",
  "is this fight too hard / too easy", "evaluate the difficulty", "review the maps and monsters I
  placed", "check the encounters before Tuesday", "will this dungeon fit in one session", "how is
  the campaign pacing", "are we on track", "review <site> before we run it", or hands over a built
  dungeon and asks what they should change. READ-ONLY: it produces a two-part report and changes
  nothing in the world unless the user says go. The bundled script owns the arithmetic; this skill
  owns what the numbers mean, which axis is actually off, and which fixes are worth the DM's time.
  Composes the read tools (list-scenes/-tokens, get-actor, get-actor-entity, get-group,
  list-journals, screenshot-scene, get-compendium-entry) with the campaign repo's plot and session
  record.
---

# Session and campaign audit

A DM who has just finished building a dungeon cannot see it. They know every room, so they cannot
feel the fourth hour of it, and they have never once added up how many hit points they placed. This
skill is the outside reader: it reads what is actually on the maps, does the arithmetic the DM
never does, and reports what will really happen on the night. The tools own the reads; this skill
owns the judgment — which axis is off, what the numbers mean, and which changes are worth making.

**Numbers before opinions, and read-only throughout.** Every claim in the report traces to a live
read or to a stated formula. An audit that guesses is worse than no audit, because it reads as
authoritative. Change nothing in the world unless the user says go.

## Step 0 — ultracode, then the brief

An audit is a wide read: every PC sheet, every placed token, every magic item, the plot doc, the
session history. At ordinary effort a model samples instead of sweeping, and a sampled audit is the
dangerous kind — confident, tidy, and blind to the one room that breaks the night.

Ultracode state arrives in a system reminder. If it says **on**, say so in one line and proceed. If
it says **off** — or nothing says either way — tell the user audits run best with it on and ask
whether to enable it or go ahead anyway, then honor the answer without arguing it twice. Never
guess: claiming a mode you cannot actually see is the same failure the rest of this skill exists to
prevent.

Then take the brief. Ask only what you cannot read: which session, which site, the play date, and
how many hours the table actually has. **Assumptions the user hands you are binding** — "assume
Morgash takes the maul, Gren the pearl" is an instruction, not a hypothesis. If a stated assumption
is factually off (they say axe, the sheet says maul), correct it in one line and carry on with
their intent; do not stop to litigate it.

## Step 1 — read wide, in this order

| Surface | Tools | What you are actually after |
|---|---|---|
| PC sheets | `get-actor` per PC | AC, HP, saves, **and whether they have Extra Attack yet** |
| Magic items | `get-actor-entity` on every attuned/equipped magic item | the item's real mechanics |
| The stash | `get-group` | loot nobody is carrying — that is a finding, not background |
| The site | `list-scenes` then `list-tokens` per scene | the roster as actually placed |
| The monsters | `get-actor` on the **placed token id** | that instance's delta, not the library actor |
| Signature abilities | `get-actor-entity` on multiattack + the gimmick | the activity, not the name |
| Intent | `list-journals` (the GM key), `plot/`, newest `gm-notes.md` | what the build was *supposed* to be |
| The ground | `screenshot-scene` on combat maps only | chokepoints, approach length, sightlines |

Four things about this list are load-bearing:

- **Extra Attack is the most-missed number in the whole audit.** A level-4 fighter, paladin, or
  ranger has *one* attack. A damage estimate that quietly assumes two is off by more than half, and
  every downstream conclusion inherits the error. Check the class level, every time.
- **Read the placed token, not the base actor.** `list-tokens` gives ids that `get-actor` accepts,
  and an unlinked token carries its own delta — different gear, different HP, sometimes a different
  name. The library actor is not what the players will fight.
- **Read the item, not its name.** "Ember-Touched Greatsword" is a common item with +1 fire and no
  attack bonus; "Goldthorn" is a +1 scimitar. You cannot tell from a sheet listing which is which.
- **Diff placed against intended.** The GM key says one thing, the tokens say another, and the gap
  is usually the best finding in the report — a named villain in the wrong room, a reveal that now
  fires out of order.

**Two gaps in the reads you must name rather than paper over.** `get-actor` returns `0`/`null` for a
PC's maximum HP — take it from the newest `party-snapshots/*.md` and say in the report which number
you used. And `get-actor` does not surface damage vulnerabilities, resistances, or immunities — read
the compendium source with `get-compendium-entry` (`compact: true`) and report it as *confirm on the
sheet*, never as an assertion. Both are tool correctness gaps, not judgment gaps (design.md §2.1);
if either bites twice, say so and propose extending `get-actor` rather than working around it again.

## Step 2 — the arithmetic (the script owns this)

Long addition across thirty creatures is exactly what a model fumbles quietly, so hand it to the
script. Assemble what you read into a JSON file and run:

```
node .claude/skills/session-audit/encounter-math.mjs --data <path>/audit-data.json
```

| option | effect |
|---|---|
| `--data <path>` | required; the assembled audit JSON (shape documented at the top of the script) |
| `--json` | emit JSON instead of markdown — use this to diff two tuning options |
| `--quiet` | tables only, no interpretation footnotes |

It returns per-room bodies / HP / XP / DMG band / estimated rounds / **enemy turns**, a
fast-table–slow-table time range against the session length, a to-hit matrix of every enemy attack
against every real PC AC, a **rounds-to-drop** line per character, and a save matrix with expected
value per use. Re-run it with `--json` against a trimmed roster to price a fix before recommending
it — that is how a recommendation earns a number. Anything you could not read comes back marked
`?` or `unread` rather than silently counted as zero; pass that marking through to the report.

Deriving each PC's damage per round is yours, not the script's, and the honest form is
`hit chance x damage on hit + riders`, where riders means masteries, once-per-turn feat damage, and
bonus attacks that actually trigger. Then **state the assumption in the report** — sustained
single-target with focus fire is a different number from a nova round, and a reader who does not
know which one you used cannot check you.

Three things the numbers mean:

- **`rounds = HP / party output` is the optimistic floor.** It assumes clean focus fire and no
  wasted turns, so a fight never runs *shorter*. Quote it as a floor.
- **Enemy turns, not rounds and not XP, predicts table time.** Ten creatures for five rounds is
  fifty turns to narrate. XP budgets cannot see how many bodies the XP is spread across, so a
  swarm and a solo read identically — treat a budget band as a prompt to look, never as a finding.
- **Price the signature mechanic.** Whatever the site's gimmick is — maximum-HP drain, a countdown,
  stacking exhaustion — compute its expected value per use and across the whole dungeon. A gimmick
  the whole site is themed on that turns out to average three points is the finding.

## Step 3 — judge four axes, not one dial

"Too hard or too easy" is almost never the true answer, and reaching for it wastes the audit. Judge
four axes separately and say which ones are off:

- **Total attrition** — incoming damage across the whole run against party HP plus the real healing
  budget (hit dice, class features, feats, potions, and what the site's clock does that healing
  cannot fix). This is the axis that decides whether anyone dies.
- **Spike** — does any single round threaten anyone, or is it flat chip damage? Flat is the more
  common failure and the more boring one.
- **Table time** — the round count against the hours available, *including* the non-combat beats
  the DM is looking forward to. Usually the headline.
- **Bite** — does the site's signature mechanic actually do what the design promises?

A dungeon can be correctly tuned for attrition and still be a bad night because it is flat and
runs long. Say that, rather than splitting the difference into "about right."

## Step 4 — fixes, ranked by the number each moves

Every fix names the number it changes: *cut ten bodies → 198 enemy turns becomes 95 → forty-five
minutes back*. A recommendation without a number is an opinion.

Rank by value to the DM, and prefer changes that cost them nothing to apply — deleting tokens, one
house-rule sentence, one `+2` — over anything that means rebuilding. Where a fix touches sheets,
offer the no-edit alternative too (a ruling that produces the same effect), because the night is
Tuesday and the DM may not want to touch the world again.

Two habits worth keeping: when the fix is "cut bodies", say *which* bodies and why that kind (chaff
that threatens is worth more than chaff that soaks); and when a fight is long because the boss is a
health bar rather than a threat, fix the threat, not the health bar.

## Step 5 — the campaign half

The session audit is worthless if the campaign it sits in is drifting, so audit that too. Read
`plot/`, the `sessions/*/recap.md` + `gm-notes.md` set, and the newest `party-snapshots/*.md`, and
work these questions:

- **Schedule against plan.** Sessions played versus the plan's own estimate, and what the real
  remaining shape is. A campaign written for six sessions being run in nine is fine; material
  sized for six stretched across nine is not.
- **Where the story beats are scheduled.** Plot documents habitually park their best reveals at the
  end of a session, which is the tiredest slot at the table. Moving a beat to the top of the next
  session is usually the single highest-value pacing note available.
- **What is under-prepped relative to the dungeons.** Compare the prep weight: four ruins with
  folders, maps, lighting and a GM key against a plot turn that is one table row. The imbalance is
  the finding.
- **Level-band cliffs.** Level 5 roughly doubles a martial party's output. Note where the next
  cliff lands and what it does to everything already built past it.
- **Ordering.** When sites can be played in any order, some orders are better — say which and why.
- **Planted setups due now.** If the doc has a payload that must be repeated every session to pay
  off later, check whether this session is one of the repetitions, and say so plainly.
- **Economy.** Money, consumables, and access to healing are pacing controls. Note when they are
  working, not just when they are broken.

## Step 6 — the report

Deliver **one two-part report**: *Part one — the site as built*, then *Part two — the campaign*.
Publish it as an artifact so the DM can keep it open on a second screen while they run, and offer
to write it into the campaign repo or as a GM-only journal (`create-journal`, GM visibility) if
they want it filed.

Part one runs: verdict findings first, severity-ranked and each with a one-line claim a reader can
disagree with; then the roster and math tables; then the ranked fixes; then a short *running it*
list of things that will come up at the table; then pre-session housekeeping (unattuned items,
loot in the stash, stale sheet values). Part two runs as findings only. Close with a line saying
what was read and when, so the reader knows the audit's shelf life.

Severity by consequence: something that will **break the night** outranks something that will make
it **feel wrong**, which outranks a **design** note. Include what is working — a DM needs to know
which parts not to touch, and an audit that only lists problems is one they will argue with rather
than use.

## Boundaries

- **Read-only unless the user says go.** Report first. If they approve fixes, apply each with the
  narrowest tool available and re-read to confirm.
- **Do not rebalance by fiat.** Recommend, price it, let the DM choose. The dungeon is theirs.
- **Do not rewrite the story.** Pacing and prep-weight notes are in scope; telling the DM their
  plot should be different is not, unless they ask.
- **Owner-stamped decisions are settled.** `*(locked YYYY-MM-DD, owner)*` in the plot doc and
  directives in the snapshots are not to be re-proposed — audit around them.
- **An approved creature change is two writes** (owner rule 2026-08-14). The prototype token and
  every token already on a scene are separate documents, so a one-sided fix leaves the world
  inconsistent in a way that depends on whether the DM drags a fresh token or uses the placed one.
  Update the base actor *and* each placed token (`update-token`, or the actor tools with the token
  id as `actorIdentifier`), and name which tokens you touched. Linked tokens are the exception —
  check linkage first.
- **Never assert a number you could not read.** Say "unread" and name the substitute you used.
- **Do not audit a live game.** If players are at the table, this is the wrong skill and the wrong
  night for it.
