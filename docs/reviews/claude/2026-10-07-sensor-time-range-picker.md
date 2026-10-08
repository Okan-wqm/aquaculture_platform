# Sensor time-range picker (2026-10-07)

Phase 3b of the sensor-history plan. It builds on the time-range table
(SENSOR-MEDIUM-152).

## SENSOR-MEDIUM-157 — no way to view a chosen past window

Stored readings could only be seen through presets that end now, and the
readings page held its range in component state, so a link or a reload lost
it.

Closed in phase 3c (`/sensor/readings`):

- The range lives in the URL (`useTimeRangeSearchParams`). A malformed link
  says so and shows the default range.
- The page picks ranges with `TimeRangePicker` in one zone that the server
  names (`seriesDisplayTimeZone`: the sensors' shared site zone, else the
  tenant's). Until the server answers, no picker is shown, so no zone is
  guessed.
- A preset re-anchors at now and refreshes; a fixed window is fetched once.
- Each chart:
  - says its bucket width, its store and the zone buckets were counted in;
  - draws its time axis in the site's zone;
  - breaks lines where a channel has no data, marking a lone bucket with a
    dot;
  - offers the series as CSV, with UTC and local times.
- An empty range shows the channel's last stored sample and a button that
  jumps to a window of the same length ending there.

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

## Independent review → fixes

An accessibility review of the first version found five medium and four low
problems. All are fixed, each with a test:

- A preset opened the custom section with the preset's clock times, so
  picking 16 September from "live" applied a five-minute window. A preset
  now opens with whole-day times.
- A keyboard move clamped at today left a focus request pending, so a later
  month button pulled focus into the grid. Focus requests are now counted,
  and a request that changes nothing does not linger.
- A window ending after today put the only tab stop on a disabled future
  day. The initial focus is clamped to today.
- Selection was not announced. Each day's name now says range start, range
  end or in range; the grid is `aria-multiselectable`; and after the second
  pick the hint reads the chosen days and the zone by its localised name.
- A link without an offset was read in the browser's zone. That parser lives
  in the time-range table, so the fix is there (SENSOR-MEDIUM-152): only ISO
  instants with `Z` or `±hh:mm` are accepted.
- PageUp/PageDown moved 30 days. They now move by calendar month, to the
  month end when the same day does not exist, and Shift moves by year.
- An error stayed after the times were fixed. Editing a time clears it, and
  while it stands the inputs carry `aria-invalid` and point at it.
- The separators were written in code. The range span, the trigger's name
  and a day's notes now come from the locale maps, and the time inputs carry
  the locale.
- Picking the preset already shown wrote a duplicate history entry, and a
  window starting after now was accepted. The first now changes nothing; the
  second is refused with its own message.

The review found nothing wrong in the zone arithmetic, the month buttons,
the trigger and preset naming, or the URL hook's handling of other
parameters. Three of the fixes were mutation-checked (whole-day times, the
clamp, the focus request): each test fails without its fix.
