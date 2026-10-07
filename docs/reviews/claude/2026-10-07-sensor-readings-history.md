# Sensor readings history page (2026-10-07)

Phase 3c of the sensor-history plan. It closes SENSOR-MEDIUM-157 (no way to
view a chosen past window) and SENSOR-HIGH-153 (invented numbers on two
routed pages); both are described in their own review files. This file
records the review of the first version and the findings it raised.

## Independent review → fixes

A chart and readings review of the first version found two high, four
medium and five low problems.

- **Outages drawn as lines.** The chart joined the two samples either side
  of a device outage, because its time axis held only timestamps with a
  point. A slow channel beside a fast one drew dots.
  - Each series now passes the server's gaps to the chart. uPlot breaks a
    line at `null` and draws through `undefined`, so a line breaks only at
    its own reported gaps and draws through a sibling's timestamps.
  - The server measures a gap against the channel's own rhythm (the median
    step between its buckets), not the bucket width. A probe sampling every
    30 minutes in 15-minute buckets is not "quiet" every other bucket; an
    outage still is.
- **"Last data" a day early.** A channel quiet longer than the freshness
  window had only its last daily bucket, a UTC midnight. Its last sample is
  now narrowed inside that day from the minute rollup (else the hourly one),
  so the label and the jump land on the sample's minute.
- **"No data" while loading.** The empty message showed before the first
  answer and kept the previous range's chart without a sign. It now waits
  for an answer for the range on screen, and shows loading while a new
  range is fetched.
- **Different channel sets.** The empty check, the export and the jump
  covered all channels while the chart drew the filtered ones. All now use
  the channels shown.
- **Zones.** A fixed window's picker label names its zone. The chart's
  tooltip shows the time in the chart's zone, with numbers in the user's
  format.
- **CSV.** See SENSOR-MEDIUM-165 below.
- **Smaller fixes.**
  - A failed zone query says so.
  - Picking the default range repairs a broken link.
  - The zone query takes a whole page of sensors at once, and the bounds
    query is batched by 100.
  - The card's buttons name their sensor.
  - Static notes no longer use `role="status"`.

Proof:

- `trend-chart-breaks.test.ts` checks the pure chart data: an outage breaks,
  a sibling's timestamps do not, and lines without gaps keep the old fill.
- `series-gaps.spec.ts` checks the rhythm rule, including a 25-hour day.
- The Postgres spec checks a quiet channel's last sample to the minute.
- The card, page and model specs cover the rest.
- Mutation checks: each of the outage break, the formula guard and the
  last-sample narrowing fails its test when removed.

Left as they were:

- The page's own Turkish literals are tracked by FE-HIGH-089 and the
  hardcoded-text ratchet.
- A failing card still raises its own alert, because its error is its own.

## SENSOR-MEDIUM-165 — the readings CSV ran tenant text as formulas

The export wrote sensor names, channel labels and units unescaped. A cell
starting with `=`, `+`, `-` or `@` runs as a formula in a spreadsheet, and
these fields are typed by tenants. It also wrote a dot decimal under a `;`
separator, which a Turkish spreadsheet reads as dates. This was on main
since the readings export landed.

Fix: CSV fields are text or numbers.

- Text that starts with a formula character is written with a leading
  apostrophe.
- Text with a separator, quote or line break is quoted.
- Numbers keep full precision, so a negative reading is not mistaken for a
  formula.
- The separator and the decimal mark follow the user's language: Turkish
  `;` and `,`, English `,` and `.`.

Both the latest-values and the series exports use it.

## SENSOR-LOW-166 — alarm counters count week-old values (open)

The warning and critical counters count each channel's last value from up
to seven days back. A probe that alarmed last week and then went quiet still
counts as a current warning. This predates phase 3c. Owner: claude.
Deadline: 2026-10-28.
