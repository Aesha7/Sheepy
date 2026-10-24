// Prints every demo scenario's plan as plain text: `npm run scenarios`
import { SCENARIOS, scenarioInputs } from '../server/scenarios.js';
import { buildPlan } from '../server/policy/buildPlan.js';

const fmtTarget = (output, t) => {
  if (output === 'light') return `${t.brightness}% ${t.colorTempK}K`;
  if (output === 'audio') return Object.keys(t.channels).length ? Object.entries(t.channels).map(([k, v]) => `${k} ${v}%`).join(' + ') : 'silent';
  return `level ${t.level}`;
};

for (const sc of SCENARIOS) {
  console.log(`\n=== [SIMULATED] ${sc.title} ===\n${sc.description}`);
  for (const run of sc.runs) {
    const i = scenarioInputs(sc, run);
    const plan = buildPlan(i.profile, i.calendar, i.weather, i.now, i.controls);
    console.log(`\n-- ${plan.userName} @ ${plan.nowLabel} | tomorrow ${plan.day.date}: ${plan.day.label} (${plan.day.source}) | routine: ${plan.routine.status}`);
    for (const e of plan.explanations) console.log(`   [${e.kind}] ${e.text}`);
    for (const output of ['light', 'audio', 'fan']) {
      for (const s of plan.outputs[output].filter((x) => x.phase !== 'awake' && x.phase !== 'morning')) {
        console.log(`   ${output.padEnd(5)} ${s.startLabel.padStart(8)}–${s.endLabel.padEnd(8)} ramp ${String(Math.round(s.transitionMinutes)).padStart(3)}m  ${fmtTarget(output, s.target).padEnd(22)}${s.overridden ? ' [OVERRIDDEN]' : ''}`);
      }
    }
  }
}
