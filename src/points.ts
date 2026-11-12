// The points of a session whose code /code-restore offers: each user message,
// for the code it was sent with, and the end of each branch, for the code the
// branch was left with. Other entries fall between these and add only noise.

export interface Entry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: { role?: string; content?: unknown };
}

export interface Point {
  id: string;
  title: string;
}

const PREVIEW = 60;

function text(entry: Entry): string | undefined {
  if (entry.type !== "message" || entry.message?.role !== "user") return undefined;
  const { content } = entry.message;
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part?.type === "text" ? part.text : "")).join(" ")
        : "";
  const line = raw.replace(/\s+/g, " ").trim();
  return line.length > PREVIEW ? `${line.slice(0, PREVIEW - 1)}…` : line;
}

function time(entry: Entry): string {
  const date = new Date(entry.timestamp);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toTimeString().slice(0, 5);
}

// Newest first. `current` is the path to the leaf, marked so that the branch
// the conversation is on stands out.
export function restorePoints(entries: Entry[], current: Set<string>): Point[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const parents = new Set(entries.map((entry) => entry.parentId));
  const lastPrompt = (entry: Entry): string => {
    for (let at: Entry | undefined = entry; at; at = at.parentId ? byId.get(at.parentId) : undefined) {
      const prompt = text(at);
      if (prompt !== undefined) return prompt;
    }
    return "";
  };

  const points: (Point & { at: string })[] = [];
  for (const entry of entries) {
    // The id keeps titles apart, and is what /code-restore takes as argument.
    const head = `${current.has(entry.id) ? "*" : " "} ${time(entry)} ${entry.id.slice(0, 8)}`;
    const prompt = text(entry);
    if (prompt !== undefined) {
      points.push({ id: entry.id, at: entry.timestamp, title: `${head} sent: ${prompt}` });
    }
    if (!parents.has(entry.id)) {
      points.push({ id: entry.id, at: entry.timestamp, title: `${head} end:  ${lastPrompt(entry)}` });
    }
  }
  // A user message with no reply yet is both; the code is the same.
  const seen = new Set<string>();
  return points
    .sort((a, b) => b.at.localeCompare(a.at))
    .filter((point) => !seen.has(point.id) && seen.add(point.id))
    .map(({ id, title }) => ({ id, title }));
}

// The entry an id or a prefix of one names: what /tree shows is shortened.
export function entryByPrefix(entries: Entry[], prefix: string): Entry | string {
  const found = entries.filter((entry) => entry.id.startsWith(prefix));
  if (found.length === 1) return found[0];
  return found.length === 0 ? `no entry starts with ${prefix}` : `${found.length} entries start with ${prefix}`;
}
