// Files kept beside the session, under <agent dir>/tree-state/<session id>/.
import { readFile } from "node:fs/promises";

const MAX_LINEAGE = 32;

interface Header {
  id?: string;
  parentSession?: string;
}

// The sessions a session was forked from, nearest first. Entries keep their
// ids in a fork, so what the parents stored still applies.
export async function ancestorSessions(header: Header | null): Promise<string[]> {
  const ids: string[] = [];
  let parent = header?.parentSession;
  while (parent && ids.length < MAX_LINEAGE) {
    let first: Header;
    try {
      first = JSON.parse((await readFile(parent, "utf8")).split("\n", 1)[0]) as Header;
    } catch {
      break;
    }
    if (!first.id) break;
    ids.push(first.id);
    parent = first.parentSession;
  }
  return ids;
}
