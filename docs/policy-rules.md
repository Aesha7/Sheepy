# Drift policy rules

The policy engine is one deterministic function in [server/policy/buildPlan.js](../server/policy/buildPlan.js):

```
buildPlan(userProfile, calendarContext, weatherContext, now, controls?) -> plan
```

It never reads the clock, network, or hardware, so the same inputs always produce the same plan. The
[executor](../server/devices/executor.js) is the only code that sends device commands. No LLM is involved. The
only "fuzzy" step is keyword inference of event categories ([calendar/events.js](../server/calendar/events.js)
`inferCategory`). An LLM could replace that function later, but it could only suggest a category for the user to
confirm and could never send commands.

## Priority order (highest first)

1. **Hardware limits and Stop** (executor). Volume is capped at the user's maximum; brightness at the device
   maximum; color temperature is only sent if the light supports it. Stop cancels pending changes and overrides,
   silences audio, turns the fan off, holds lights at their last confirmed level, and pauses automation.
2. **Manual overrides.** They apply immediately and last until their displayed expiry or until cleared, then the
   output glides back to the plan over 5 minutes.
3. **Confirmed sleep and wake schedule.** Times change only through the user's preferences or a proposal the user
   accepted. Accepted values are locked for that night.
4. **User preferences.** Brightness limit, warmth, sound choice, level and cap, rain/storm feelings, weather mode.
5. **Calendar-based routine.** Offered as proposals; applied only after acceptance.
6. **Weather and outdoor mirroring.** Used only while awake (lights) or as steady scheduled windows (sound).

## Which night, and "tomorrow"

- The plan covers the night that ends at the user's **next wake time after `now`**, computed in the user's
  timezone. "Tomorrow" is that wake date. At 2 AM you are still in last night's plan; just after waking, the next
  night is planned.
- Bedtime is the latest occurrence of the bedtime clock before wake, so 00:30 bedtimes work. DST nights keep
  wall-clock times (a fall-back night is 9 hours for 11 PM to 7 AM).

## Day categories

| Category | Inferred when | Routine offered (needs acceptance) |
|---|---|---|
| Exam / important presentation | an event is marked important, or its category or title suggests exam/presentation | longer wind-down preset; familiar sound kept steady with no weather layers; wake time unchanged |
| Early start / busy day | first event (minus any prep/travel the user entered) is within the user's threshold of wake time, or 5+ events / 6+ hours | earlier bedtime by the user's preset; wake time unchanged |
| Relaxation day / day off | an event is categorized or titled day off / vacation / holiday | relaxed wind-down; gentler, longer wake ramp; later wake time only if the user allowed it, and only after approval |
| Normal | events exist but none of the above | standard routine |
| Unknown | no calendar, unreadable calendar, or no events | standard routine |

- Explicit user day labels override inference. Inferred labels are shown as "inferred: please check".
- An **empty calendar is "unknown", never "day off"**.
- Important + relaxing (or early + relaxing) signals: the user is asked to choose; until then the standard routine
  is used.
- Prep/travel time is never invented. If an event starts before the confirmed wake time, Drift shows a notice and
  changes nothing.
- Relabeling a day clears that night's accept/decline decisions.

## Lighting

- **Awake, mirroring on, location known:** hourly sky buckets (clear / partly / overcast) from a fresh forecast set
  a daytime scene within the brightness limit (`softer`, `dimmer`, or `unchanged` on cloudy days). Runs shorter
  than 2 hours are absorbed so lights don't wobble. Changes fade over 30 minutes. From 45 minutes before sunset the
  lights ease to the warm evening scene over an hour.
- **Weather missing or stale:** the neutral daytime scene, still timed to calculated sunset.
- **Mirroring off (or no location):** scheduled scenes. Daytime scene, then the evening scene 2 hours before
  wind-down.
- **Wind-down:** dims to 25% of the limit at the user's evening warmth over the whole wind-down.
- **Bedtime → wake window:** off (or the user's night-light level). Sunrise, weather and lightning never change
  lights while asleep, and nothing ever flashes.
- **Wake window:** brightens only inside the approved ramp ending at the confirmed (or accepted) wake time.
- Brightness and color temperature are separate fields; the executor drops color temperature for lights that
  don't support it.

## Sound

- `silence` is a valid preference: weather never switches sound on for it (except when the user explicitly chose
  *mask* mode, which plays only during the storm window).
- Base routine: fade in at 60% of the usual level at wind-down, settle at the usual level at bedtime, then hold all
  night (or fade out after 30 minutes if overnight sound is off), and fade out across the wake window.
- **Mirror mode:** if rain is forecast and the user finds rain calming, a rain layer fades in over 20 minutes under
  the user's sound. Total output stays at the usual level. No thunder effects, ever. Not added on important nights,
  for users who find rain neutral or distracting, or while the user's sound is off.
- **Mask mode:** during storm windows (if storms bother the user) and rain windows (if rain is distracting), the
  user's saved masking sound fades in 30 minutes early at the **usual level, never higher**. It is steady and never
  reacts to individual sounds. On important nights the familiar sound is kept instead.
- **Off:** weather never changes sound.
- Levels are digital output levels, never presented as measured loudness.

## Weather data handling

- Current observation: fresh if under 3 hours old. Forecast: fresh if fetched within 12 hours **and** it covers
  through wake time. Anything else is stale; missing data is reported as missing.
- Stale or missing forecast → no weather-driven changes at all (the standard routine).
- Windows use hysteresis: rain opens at ≥50% and stays open at ≥30%; storms at ≥40% / ≥25%.
- Anti-oscillation (`stabilizeWindows`): a window that has started keeps its start time. If a new forecast drops
  it, it is held up to an hour and then fades out. Future windows ignore shifts under 45 minutes. Segments with an
  unchanged target continue their ramp instead of restarting it.

## Executor safety

- Automatic changes are slew-limited (brightness ≤1%/s, color ≤40 K/s, volume rises ≤0.5%/s).
- Identical commands are deduplicated; each device gets at most one command per tick interval (2 s).
- Desired, sent, and confirmed state are tracked separately, with statuses `pending`, `applied`, `disconnected`,
  `failed`. Browser audio counts as applied only after the tab acknowledges playback.
- The accelerated preview is a pure function of the plan (`previewFrames`) and never touches devices or real
  timers.

## Feedback

Morning check-in answers produce **suggestions** (for example, lower the brightness limit by 10%). Nothing changes
until the user presses Apply. Volume suggestions never exceed the cap, and feedback never changes wake times.
