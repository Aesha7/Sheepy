# Planner Test Cases

Rules: default wake 7:30 AM, wake 60 min before an early commitment, 8h sleep (8.5h on a bad night), light = wake + 30 min, caffeine cutoff = bedtime - 8h, wind-down = bedtime - 60 min.

"Prev day" means the evening before the wake date.

## Expected outputs

| Case | Wake | Light | Caffeine cutoff | Wind-down | Bedtime |
|---|---|---|---|---|---|
| No events, normal | 7:30 AM | 8:00 AM | Prev day 3:30 PM | Prev day 10:30 PM | Prev day 11:30 PM |
| No events, bad night | 7:30 AM | 8:00 AM | Prev day 3:00 PM | Prev day 10:00 PM | Prev day 11:00 PM |
| 7 AM meeting, normal | 6:00 AM | 6:30 AM | Prev day 2:00 PM | Prev day 9:00 PM | Prev day 10:00 PM |
| 7 AM meeting, bad night | 6:00 AM | 6:30 AM | Prev day 1:30 PM | Prev day 8:30 PM | Prev day 9:30 PM |

## Behavior cases

| Case | Expected |
|---|---|
| Only all-day events | Same as "No events" |
| 10 AM meeting (not early) | Same as "No events" |
| Multiple events, shuffled order | Earliest relevant event determines wake |
| Missing sleep data | Plan still generated using defaults, no crash |
| Flight fixture | Uses explicit fixture departure info only |
| Free-text "Flight to Tokyo" with no metadata | Treated as a normal event, no inferred time zone |

## Edge cases (design decisions needed)

- **Daylight saving ends Sunday, Nov 1, 2026 (US):** the clock repeats 1:00-2:00 AM. For a 6 AM wake, bedtime should be computed using elapsed time (8 real hours), which gives 11 PM the night before, not 10 PM.
- **Midnight crossing:** a bedtime after 12:00 AM must be dated as the next calendar day, not the same day.
- **Different planning time zone:** results must follow `PlanRequest.timeZone`, not the device time zone.

## Test checklist

- [ ] Normal sleep
- [ ] Bad sleep
- [ ] Early meeting
- [ ] Missing data
- [ ] Flight fixture
- [ ] Midnight crossing
- [ ] Daylight saving transition
- [ ] Shuffled event order
- [ ] All-day only
