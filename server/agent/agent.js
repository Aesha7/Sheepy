// The Drift agent loop: Claude (via the official Anthropic SDK) decides, tools act.
// A manual loop rather than the SDK tool runner so every step can be logged for the dashboard,
// Stop can abort a run mid-flight, and the iteration count stays bounded.

import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './prompt.js';
import { ALL_TOOLS } from './tools.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const short = (v, n = 1200) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

export class AgentRunError extends Error {
  constructor(kind, message, { retryable = true } = {}) {
    super(message);
    this.kind = kind;
    this.retryable = retryable;
  }
}

/** Classify an SDK error for the dashboard and for whether to keep trying later. */
export function describeApiError(e) {
  if (e instanceof AgentRunError) return e;
  if (e?.name === 'AbortError' || e instanceof Anthropic.APIUserAbortError) return new AgentRunError('aborted', 'Stopped by the person.', { retryable: false });
  if (e instanceof Anthropic.AuthenticationError) return new AgentRunError('auth', 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env.', { retryable: false });
  if (e instanceof Anthropic.PermissionDeniedError) return new AgentRunError('permission', `The API key lacks permission: ${e.message}`, { retryable: false });
  if (e instanceof Anthropic.NotFoundError) return new AgentRunError('model', `Model not found: ${e.message}`, { retryable: false });
  if (e instanceof Anthropic.RateLimitError) return new AgentRunError('rate_limit', 'Rate limited by the Anthropic API. Using backup rules until the next event.');
  if (e instanceof Anthropic.BadRequestError) return new AgentRunError('bad_request', `The API rejected the request: ${e.message}`, { retryable: false });
  if (e instanceof Anthropic.APIConnectionError) return new AgentRunError('offline', 'Can’t reach the Anthropic API (no internet?). Using backup rules.');
  if (e instanceof Anthropic.APIError) return new AgentRunError('api', `Anthropic API error ${e.status ?? ''}: ${e.message}`);
  return new AgentRunError('error', e?.message ?? String(e));
}

export class DriftAgent {
  /**
   * @param {{client, execute: (name, input) => Promise<any>, model?, effort?, maxIterations?, maxTokens?, tools?}} opts
   */
  constructor({ client, execute, model = DEFAULT_MODEL, effort = 'medium', maxIterations = 10, maxTokens = 16000, tools = ALL_TOOLS }) {
    this.client = client;
    this.execute = execute;
    this.model = model;
    this.effort = effort;
    this.maxIterations = maxIterations;
    this.maxTokens = maxTokens;
    this.tools = tools;
  }

  request(messages) {
    return {
      model: this.model,
      max_tokens: this.maxTokens,
      // A declined request is re-run server-side on Anthropic's recommended fallback model.
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: { effort: this.effort },
      // Tools and system prompt never change between runs, so this prefix is cacheable.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: this.tools,
      messages,
    };
  }

  /**
   * One run, woken by an event. Returns {text, steps, usage, iterations, model}.
   * Throws AgentRunError on API failure, refusal, truncation or the iteration cap.
   */
  async run({ event, snapshot, signal, onStep }) {
    const messages = [{
      role: 'user',
      content: `Event: ${event}\nSnapshot (JSON): ${JSON.stringify(snapshot)}\n\nDecide what the sheep's light and the speaker should do now and later tonight, act with the tools, then reply with your note to the person.`,
    }];
    const steps = [];
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let served = this.model;

    for (let i = 1; i <= this.maxIterations; i++) {
      if (signal?.aborted) throw new AgentRunError('aborted', 'Stopped by the person.', { retryable: false });
      let res;
      try {
        res = await this.client.beta.messages.create(this.request(messages), { signal });
      } catch (e) {
        throw describeApiError(e);
      }
      served = res.model ?? served;
      for (const k of Object.keys(usage)) usage[k] += res.usage?.[k] ?? 0;

      if (res.stop_reason === 'refusal') {
        throw new AgentRunError('refusal', `The model declined this request${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}. Using backup rules.`, { retryable: false });
      }
      if (res.stop_reason === 'max_tokens') throw new AgentRunError('truncated', 'The agent’s reply was cut off (max_tokens). Using backup rules.');

      const toolUses = res.content.filter((b) => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || toolUses.length === 0) {
        const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        return { text, steps, usage, iterations: i, model: served };
      }

      // Append the assistant turn unchanged (thinking blocks included), then all results in one message.
      messages.push({ role: 'assistant', content: res.content });
      const results = [];
      for (const tu of toolUses) {
        if (signal?.aborted) throw new AgentRunError('aborted', 'Stopped by the person.', { retryable: false });
        const step = { tool: tu.name, input: tu.input, at: Date.now() };
        try {
          const out = await this.execute(tu.name, tu.input);
          step.result = out;
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
        } catch (e) {
          step.error = e.message;
          results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: e.message });
        }
        steps.push(step);
        onStep?.({ ...step, result: step.result === undefined ? undefined : short(step.result) });
      }
      messages.push({ role: 'user', content: results });
    }
    throw new AgentRunError('iterations', `The agent didn’t finish within ${this.maxIterations} steps. Using backup rules.`);
  }
}

export function createClient(config) {
  if (!config.agentApiKey) return null;
  return new Anthropic({ apiKey: config.agentApiKey, maxRetries: 2, timeout: 120_000 });
}
