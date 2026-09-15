export type Mark = "import" | "reject";

export type DecisionMeta = {
  updatedAt: number;
  writer: string;
};

export type DecisionState = {
  decisions: Record<string, Mark>;
  decisionMeta: Record<string, DecisionMeta>;
};

export function isMark(value: unknown): value is Mark {
  return value === "import" || value === "reject";
}

export function compareDecisionMeta(a: DecisionMeta, b: DecisionMeta) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
  return a.writer.localeCompare(b.writer);
}

export function mergeDecisionState(a: DecisionState, b: DecisionState): DecisionState {
  const decisions: Record<string, Mark> = {};
  const decisionMeta: Record<string, DecisionMeta> = {};
  const ids = new Set([...Object.keys(a.decisions), ...Object.keys(b.decisions)]);

  for (const id of ids) {
    const left = a.decisions[id];
    const right = b.decisions[id];
    if (!left && !right) continue;
    if (!left) {
      decisions[id] = right;
      decisionMeta[id] = b.decisionMeta[id];
      continue;
    }
    if (!right) {
      decisions[id] = left;
      decisionMeta[id] = a.decisionMeta[id];
      continue;
    }

    const leftMeta = a.decisionMeta[id];
    const rightMeta = b.decisionMeta[id];
    if (compareDecisionMeta(leftMeta, rightMeta) >= 0) {
      decisions[id] = left;
      decisionMeta[id] = leftMeta;
    } else {
      decisions[id] = right;
      decisionMeta[id] = rightMeta;
    }
  }

  return { decisions, decisionMeta };
}
