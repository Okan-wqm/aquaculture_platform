# Sensor time-range picker (2026-10-07)

Phase 3b of the sensor-history plan. It builds on the time-range table
(SENSOR-MEDIUM-152).

## SENSOR-MEDIUM-157 — no way to view a chosen past window (open)

Stored readings can only be seen through presets that end now. The readings
page holds its range in component state, so a link or a reload loses it.
Phase 3c wires the page to the parts below and closes this finding (owner:
claude, deadline 2026-10-21).

## SENSOR-MEDIUM-158 — no usable range picker or URL range state

shared-ui's only range picker, `DateRangePicker`, was unused. It:

- wrote dates in en-US;
- picked whole days only;
- had no keyboard grid;
- kept its own table of date presets;
- read days in the browser's time zone.

No hook kept a page's range in its URL.

What this change adds:

- `zonedTime.ts` converts between a wall clock and an instant in a named
  IANA zone, using `Intl` only. A time inside a spring-forward gap moves
  forward by the gap. A time inside a fall-back overlap takes the earlier
  instant (Temporal's `compatible`). Nothing reads the browser zone.
- `RangeCalendar` is one month of days in the WAI-ARIA date-grid pattern:
  - arrows, Home/End and PageUp/PageDown move the focus, with a roving tab
    stop that stays inside the shown month;
  - month and weekday names come from `Intl` in the active locale, and the
    week starts on Monday in Turkish;
  - future days are disabled;
  - days outside the stored data are read out as "no data stored".
- `TimeRangePicker` is built on the shared `Popover`, which gives it dialog
  semantics, Escape, and focus in and back:
  - It offers a surface's presets, or a fixed window chosen on the calendar
    with start and end times.
  - The zone is a required input.
  - Times name whole minutes: the end is the last instant of its minute, so
    00:00–23:59 covers the chosen days fully and a fixed window reopens on
    the same days and times.
  - Range errors use the table's check. A missing day or time has its own
    message.
- `useTimeRangeSearchParams` keeps the range in the URL (`?range=` or
  `?from=&to=`) and leaves other parameters alone:
  - an absent range gives the page's default;
  - a malformed one gives the default plus an error the page shows.
- `DateRangePicker` is removed. Nothing imported it, and it carried a second
  copy of date presets.

Which zone a site's chart uses is decided once, on the server. Farm-service
already resolves it for feeding (`sites.timezone`, then the tenant's
localization, then UTC). The series response reports it as `bucketTimeZone`.
Phase 3b-2 makes sensor-service resolve that zone for the sensors it reads
and align day buckets to it. The page then passes the reported zone to the
picker, so the browser never guesses it.

Proof, run with the browser zone set to Los Angeles, New York and Tokyo:

- `zonedTime.spec.ts`:
  - fixed-offset and daylight-saving zones;
  - the gap and the overlap;
  - a round trip of every hour of a year in Europe/Oslo, where only the
    repeated autumn hour maps to its earlier twin.
- `TimeRangePicker.spec.tsx`:
  - presets;
  - whole days, and times read in the chart zone;
  - an incomplete draft;
  - reopening a fixed window;
  - days without data and future days;
  - keyboard movement and Escape.
- `useTimeRangeSearchParams.spec.tsx`:
  - default, link, malformed link;
  - writing a range while keeping other parameters.

The shared-ui hardcoded-text ratchet ceiling drops from 194 to 190, with the
removed component.
