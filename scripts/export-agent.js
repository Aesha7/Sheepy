// Exports the agent's system prompt and tool definitions for the iOS app, so the phone and the web
// agent stay identical. Run after changing server/agent/prompt.js or tools.js: `npm run export-agent`

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT } from '../server/agent/prompt.js';
import { SHEEP_TOOLS, DRIFT_TOOLS } from '../server/agent/tools.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'ios', 'SleepSheep', 'AgentResources');

// On the phone: the sheep tools over Bluetooth, local scheduling, and Drift's context from the laptop.
const keep = new Set(['schedule_action', 'list_scheduled', 'cancel_scheduled']);
const phoneTools = [
  ...SHEEP_TOOLS,
  ...DRIFT_TOOLS.filter((t) => keep.has(t.name)),
  {
    name: 'get_drift_context',
    description: "The person's saved preferences, tonight's confirmed schedule and tomorrow's day type, and the weather for their location, read from the Drift server on the laptop. Fails if the laptop isn't reachable; then rely on the settings in the message.",
    input_schema: { type: 'object', properties: {} },
  },
];

const PHONE_ADDENDUM = `

On this phone build
- Tools here: set_lamp, get_status and read_pat_log (the sheep over Bluetooth), schedule_action, list_scheduled and cancel_scheduled (timers in the app, which only fire while the app is open), and get_drift_context (preferences, schedule and weather from the Drift server on the laptop).
- There is no sound tool on the phone. If sound would help, say what you'd play and let the person start it.
- If get_drift_context fails, use the bedtime, wake time and brightness limit given in the message.`;

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'system-prompt.txt'), SYSTEM_PROMPT + PHONE_ADDENDUM + '\n');
fs.writeFileSync(path.join(out, 'tools.json'), JSON.stringify(phoneTools, null, 2) + '\n');
console.log(`Wrote ${path.relative(root, out)}/system-prompt.txt and tools.json (${phoneTools.length} tools)`);
