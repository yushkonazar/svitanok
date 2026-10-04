# Check-in v2

The shared catalog `web/core/checkin/catalog.mjs` defines the form, allowed answers and server validation. The Mini App uses `CheckinV2Screen`; `questions.ts` remains a registry of legacy labels for historical records.

## Questions and preferences

- Morning: sleep mode and actual duration/precision, sleep quality when applicable, independent energy/mood, one priority.
- Afternoon: independent energy/mood and tension.
- Evening: independent energy/mood, day satisfaction, priority outcome, up to three actual activities, movement range with optional exact duration.
- Six voluntary modules: sleep details, learning, attention/load, body/recovery, support and custom habits. The picker exposes up to three extra cards at a time; previously answered extras remain in the final review.
- `settings.checkin` contains modules, Kyiv schedule, custom habits with weekdays, custom activity categories and hidden defaults. Disabling a module does not erase its history.

## Storage and confirmation

New meanings use new `V2` keys and `questionVersion: 2`. Unchanged energy/mood remain explicit independent scales. Each confirmed slot contains the actual answer timestamp, timezone, per-field answer timestamps/periods and snapshots of category/habit labels. Core questions must be complete to confirm. Partial drafts never count as completed and never suppress reminders. Confirmed slots are immutable.

Canonical storage remains the existing StateStoreDO stats/settings blobs and their existing mirrors. No database migration or rewriting of old answers is required. The server determines the current slot and logical day from the configured Kyiv windows; a stale date/slot returns 409 and incomplete confirmation returns 422.

Opening the application after marking sleep records an opening timestamp only. It does not infer waking, sleep duration or sleep quality. The sleep marker can be offered as a recent suggestion that the user explicitly confirms. No sleep is explicitly zero duration without a quality score. Naps require their own reported duration; overlapping recorded episodes are flagged and excluded from combined nap totals.

## Statistics

`observations.mjs` analyzes only confirmed v2 observations. The My State page exposes 7/30/90-day periods with previous-period comparisons, fixed rating axes, calendar gaps and interactive dates linked to the actual answers. The raw API window is 180 days, supporting a 90-day comparison. Existing server retention stays unchanged.

The main sections are rhythm by time of day, sleep, intention/outcome, learning, factors and descriptive period facts. An expandable explorer covers other optional observations. Habits remain separate from mood and day satisfaction. Activity frequencies count days, including stable groups once per day; they are never presented as hours. Missing/unknown/not-applicable answers never become zero. Approximate durations are labeled.

Factor groups require explicit responses in both groups and at least eight observations each before displaying their difference. Differences describe co-occurrence, never causation. New records do not feed the legacy weighted indices. Legacy answers remain accessible separately.

Weekly/monthly archives preserve v2 means and their denominators separately from legacy scales. The assistant receives compact deterministic period metrics, without expanding every daily record or making an LLM request per answer. Voluntary weekly reflections are stored in stats.

## Validation

Server tests cover partial confirmation, clocks across midnight, drafts/reminders, explicit timestamps, sleep/no-sleep/naps, exclusivity and selection limits, unchanged legacy records, period aggregates and archives. Frontend tests cover independent affect choices, selection limits, actual duration entry, empty statistics and chart/context alignment when changing periods. Mobile review uses isolated demo data.
