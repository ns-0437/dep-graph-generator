import OpenAI from "openai";
import { canonicalFieldKey, isCircularProducer, type IndexedField } from "./match.js";
import type { Edge, InputField } from "../types.js";

/** The minimal slice of the OpenAI SDK's surface llmDisambiguate actually calls, so tests
 * can inject a fake client instead of hitting the network. */
export interface ChatClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: { role: "user"; content: string }[];
        temperature: number;
      }): Promise<{ choices: { message: { content: string | null } }[] }>;
    };
  };
}

/**
 * Loosely-matching candidates for a required field the heuristic couldn't resolve: any
 * output leaf sharing at least one token with the input name, ranked by overlap. Used to
 * hand an LLM a short, pre-filtered multiple-choice list instead of the entire catalog.
 *
 * requiredNamesByTool excludes circular producers the same way the heuristic matching loop
 * in generate.ts does (see isCircularProducer in match.ts): a field the heuristic couldn't
 * resolve precisely *because* every real candidate was circular must not hand those same
 * circular producers to the LLM undefended -- it has no way to know a candidate is circular
 * from field/type names alone, and will happily pick the semantically obvious (but circular)
 * one right back. Optional only so existing direct callers/tests that don't care about
 * circularity aren't forced to pass an empty map.
 */
export function looseCandidates(
  input: InputField,
  consumerSlug: string,
  outputsByTool: Map<string, IndexedField[]>,
  limit: number,
  requiredNamesByTool?: ReadonlyMap<string, ReadonlySet<string>>,
) {
  const canonicalInputName = canonicalFieldKey(input.name);
  const scored: { slug: string; leaf: string; type: string; overlap: number }[] = [];
  for (const [slug, fields] of outputsByTool) {
    if (slug === consumerSlug) continue;
    const requiredNames = requiredNamesByTool?.get(slug);
    if (requiredNames && isCircularProducer(canonicalInputName, requiredNames)) continue;
    for (const f of fields) {
      const overlap = f.tokens.filter((t) => input.tokens.includes(t)).length;
      if (overlap > 0) scored.push({ slug, leaf: f.field.name, type: f.field.parentType, overlap });
    }
  }
  scored.sort((a, b) => b.overlap - a.overlap);
  const seenKey = new Set<string>();
  const out: typeof scored = [];
  for (const s of scored) {
    const key = `${s.slug}:${s.leaf}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Extracts the first top-level JSON array from free-form model output via bracket-balance
 * scanning, not a greedy regex. `/\[[\s\S]*\]/` matches from the FIRST "[" to the LAST "]"
 * anywhere in the text -- if the model appends any trailing remark containing a "]" (e.g.
 * referencing "candidate_producers[0]", a completely normal thing for a model to do even
 * when told to respond with ONLY the array), the greedy match swallows that prose into the
 * "JSON", JSON.parse throws, and the catch below silently drops the WHOLE batch of up to 25
 * items -- even though the model's actual answer was fully correct. Confirmed directly: a
 * response of `[{"idx":0,"ci":0}]\n\nNote: candidate_producers[0] was the best match here.`
 * failed to parse and dropped a correct edge before this fix. Tracks string state so a "["
 * or "]" inside a quoted string (e.g. an output_field value) doesn't miscount the depth.
 */
function extractJsonArray(text: string): string | undefined {
  const start = text.indexOf("[");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Batched LLM pass over fields the heuristic couldn't resolve. Multiple-choice, not free
 * text, to keep it cheap and reliable: for each unresolved field we hand the model a short
 * list of loosely-matching candidates and ask it to pick one or none.
 */
export async function llmDisambiguate(
  unresolved: { consumer: string; field: InputField }[],
  outputsByTool: Map<string, IndexedField[]>,
  client?: ChatClient,
  requiredNamesByTool?: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<Edge[]> {
  if (unresolved.length === 0) return [];
  const apiKey = process.env.OPENAI_API_KEY;
  if (!client && !apiKey) return [];
  const baseURL = process.env.OPENAI_BASE_URL;
  const model = process.env.OPENAI_MODEL ?? "openai/gpt-4o";
  client ??= new OpenAI({ apiKey, baseURL });

  const items = unresolved
    .map((u) => ({ ...u, candidates: looseCandidates(u.field, u.consumer, outputsByTool, 5, requiredNamesByTool) }))
    .filter((u) => u.candidates.length > 0);

  const BATCH = 25;
  const results: Edge[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const payload = batch.map((u, idx) => ({
      idx,
      consumer_tool: u.consumer,
      required_field: u.field.name,
      candidate_producers: u.candidates.map((c, ci) => ({
        ci,
        producer_tool: c.slug,
        output_field: c.leaf,
        output_object_type: c.type,
      })),
    }));
    const prompt =
      "For each item, decide which candidate_producer (if any) plausibly supplies the " +
      "value for required_field of consumer_tool, based on API semantics (e.g. an " +
      '"issue_number" field is supplied by a "number" field on an "Issue" object). ' +
      'Respond with ONLY a JSON array like [{"idx":0,"ci":2},{"idx":1,"ci":null}] — ' +
      "ci is the chosen candidate's ci, or null if none plausibly apply.\n\n" +
      `Items:\n${JSON.stringify(payload)}`;
    try {
      const resp = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      });
      const text = resp.choices[0]?.message?.content ?? "[]";
      const extracted = extractJsonArray(text);
      const parsed: { idx: number; ci: number | null }[] = JSON.parse(extracted ?? text);
      for (const { idx, ci } of parsed) {
        if (ci === null || ci === undefined) continue;
        const u = batch[idx];
        const c = u?.candidates[ci];
        if (u && c) results.push({ from: c.slug, to: u.consumer, label: u.field.name });
      }
    } catch (err) {
      console.error("LLM disambiguation batch failed, skipping batch:", (err as Error).message);
    }
  }
  return results;
}
