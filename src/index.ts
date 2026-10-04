import { Hono } from "hono";
import {
  LayaNotRunning,
  LAYA_NOT_RUNNING,
  choiceOf,
  confidenceOf,
  isAbstained,
  layaHealth,
  predict,
  predictBatch,
  scoreOf,
  type Question,
} from "./laya.ts";

const PORT = 3004;
const MIN_CONFIDENCE = 0.6;

const OFFER = ["walkthrough", "trial", "queue", "human_review"] as const;
const HOOK = ["absent", "soft", "direct", "hard"] as const;
const AUDIENCE = ["studios", "operators", "founders", "readers"] as const;

const criteria = {
  offer: {
    walkthrough: "Invites a look or a demo",
    trial: "Offers a time-boxed try",
    queue: "Promises a sorting or labeling outcome",
    human_review: "Says a person still decides",
  },
  hook: {
    absent: "No real hook",
    soft: "Calm, low-pressure framing",
    direct: "States the product in one line",
    hard: "Pushes a contrast or a deadline",
  },
  audience: {
    studios: "Small creative shops",
    operators: "People who run the queue",
    founders: "Someone deciding whether to try it",
    readers: "A general reader, not a named role",
  },
} as const;

const questions: Record<string, Question> = {
  offer: {
    type: "choice",
    instructions: "Which offer does this ad text actually make? Pick one label.",
    criteria: { ...criteria.offer },
  },
  hook: {
    type: "score",
    instructions: "How hard does the hook push? Ordered from none to hard.",
    criteria: [...HOOK],
  },
  audience: {
    type: "choice",
    instructions: "Who is the line for? Pick one label.",
    criteria: { ...criteria.audience },
  },
};

type ChoiceLabel = { status: "label"; choice: string; confidence: number | null } | { status: "abstain" };
type ScoreLabel = { status: "label"; level: string; value: number; confidence: number | null } | { status: "abstain" };

type AdCard = {
  id: string;
  advertiser: string;
  text: string;
  status: "pending" | "labeled";
  offer: ChoiceLabel | null;
  hook: ScoreLabel | null;
  audience: ChoiceLabel | null;
  model: string | null;
  createdAt: string;
};

const board: AdCard[] = [];

const seeds: Array<{ id: string; advertiser: string; text: string }> = [
  {
    id: "a1",
    advertiser: "Northwind Loom",
    text: "A quieter inbox for studios. See how notes get a lane before anyone replies.",
  },
  {
    id: "a2",
    advertiser: "Paperlane",
    text: "Try the walkthrough. Bring one messy thread and leave with a queue.",
  },
  {
    id: "a3",
    advertiser: "Kite & Co",
    text: "Quiet offer for operators. A trial lane, nothing loud.",
  },
  {
    id: "a4",
    advertiser: "Harborline",
    text: "The hook is simple: a human still decides what ships.",
  },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

function blank(input: { id: string; advertiser: string; text: string }): AdCard {
  return {
    id: input.id,
    advertiser: input.advertiser,
    text: input.text,
    status: "pending",
    offer: null,
    hook: null,
    audience: null,
    model: null,
    createdAt: new Date().toISOString(),
  };
}

function stateOf(card: AdCard) {
  return { id: card.id, advertiser: card.advertiser, text: card.text };
}

function choiceLabel(
  answer: Awaited<ReturnType<typeof predict>>["answers"][string],
  allowed: readonly string[],
): ChoiceLabel {
  const choice = choiceOf(answer, allowed);
  if (isAbstained(answer, MIN_CONFIDENCE) || !choice) return { status: "abstain" };
  return { status: "label", choice, confidence: confidenceOf(answer) };
}

function applyResult(card: AdCard, result: Awaited<ReturnType<typeof predict>>): AdCard {
  const hookAnswer = result.answers.hook;
  const hookScore = scoreOf(hookAnswer, HOOK);
  const hook: ScoreLabel =
    isAbstained(hookAnswer, MIN_CONFIDENCE) || !hookScore
      ? { status: "abstain" }
      : { status: "label", level: hookScore.level, value: hookScore.value, confidence: confidenceOf(hookAnswer) };
  return {
    ...card,
    status: "labeled",
    offer: choiceLabel(result.answers.offer, OFFER),
    hook,
    audience: choiceLabel(result.answers.audience, AUDIENCE),
    model: result.model,
  };
}

let tail: Promise<void> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(() => undefined, () => undefined);
  return run;
}

async function labelPending(): Promise<void> {
  const pending = board.filter((card) => card.status === "pending");
  if (pending.length === 0) return;
  const results = await predictBatch(pending.map(stateOf), questions, MIN_CONFIDENCE);
  pending.forEach((card, i) => {
    const next = applyResult(card, results[i]!);
    const idx = board.findIndex((row) => row.id === card.id);
    if (idx >= 0) board[idx] = next;
  });
}

const app = new Hono();
const page = await Bun.file(new URL("../public/index.html", import.meta.url)).text();

app.get("/", (c) => c.html(page));

app.get("/api/health", async (c) => {
  const health = await layaHealth();
  if (!health.ok) return c.json({ ok: false, error: LAYA_NOT_RUNNING }, 503);
  return c.json({ ok: true, model_loaded: health.modelLoaded, laya_version: health.version });
});

app.get("/api/board", (c) => c.json({ criteria, ads: board, min_confidence: MIN_CONFIDENCE }));

app.post("/api/score", async (c) => {
  try {
    await enqueue(labelPending);
    return c.json({ ads: board });
  } catch (err) {
    if (err instanceof LayaNotRunning) return c.json({ error: LAYA_NOT_RUNNING }, 503);
    throw err;
  }
});

app.post("/api/batch", async (c) => {
  const raw: unknown = await c.req.json().catch(() => null);
  if (!isRecord(raw) || !Array.isArray(raw.ads)) return c.json({ error: "ads must be an array" }, 400);
  if (raw.ads.length === 0 || raw.ads.length > 50) return c.json({ error: "send between 1 and 50 ads" }, 400);
  const added: AdCard[] = [];
  for (const entry of raw.ads) {
    if (!isRecord(entry)) return c.json({ error: "each ad must be an object" }, 400);
    const advertiser = str(entry.advertiser, 200);
    const text = str(entry.text, 8000);
    if (!advertiser || !text) return c.json({ error: "each ad needs advertiser and text" }, 400);
    const id = str(entry.id, 80) ?? crypto.randomUUID();
    const card = blank({ id, advertiser, text });
    board.push(card);
    added.push(card);
  }
  try {
    await enqueue(async () => {
      const results = await predictBatch(added.map(stateOf), questions, MIN_CONFIDENCE);
      added.forEach((card, i) => {
        const idx = board.findIndex((row) => row.id === card.id);
        if (idx >= 0) board[idx] = applyResult(board[idx]!, results[i]!);
      });
    });
    return c.json({ ads: added.map((card) => board.find((row) => row.id === card.id)) }, 201);
  } catch (err) {
    if (err instanceof LayaNotRunning) return c.json({ error: LAYA_NOT_RUNNING }, 503);
    throw err;
  }
});

app.onError((err, c) => {
  console.error(err);
  if (err instanceof LayaNotRunning || (err instanceof Error && err.message === LAYA_NOT_RUNNING)) {
    return c.json({ error: LAYA_NOT_RUNNING }, 503);
  }
  return c.json({ error: "internal error" }, 500);
});

if (import.meta.main) {
  for (const seed of seeds) board.push(blank(seed));
  Bun.serve({ port: PORT, fetch: app.fetch });
  console.log(`adtear listening on http://localhost:${PORT}`);
}
