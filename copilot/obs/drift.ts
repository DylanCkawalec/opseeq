// obs/drift.ts — Cosine-distance drift between original prompt and current output.
import { env } from "../models/env.ts";
import { OllamaProvider } from "../models/ollama.ts";

export interface DriftScorer {
  score(reference: string, candidate: string): Promise<number>;
}

export class CosineDriftScorer implements DriftScorer {
  private cachedRef?: { text: string; vec: number[] };
  private readonly model: string;
  private readonly ollama = new OllamaProvider();

  constructor() {
    this.model = env("EMBEDDING_MODEL", "nomic-embed-text");
  }

  async score(reference: string, candidate: string): Promise<number> {
    const refVec = await this.embed(reference, this.cachedRef);
    if (!this.cachedRef || this.cachedRef.text !== reference) {
      this.cachedRef = { text: reference, vec: refVec };
    }
    const candVec = await this.embed(candidate);
    return 1 - cosine(refVec, candVec);
  }

  private async embed(text: string, cached?: { text: string; vec: number[] }): Promise<number[]> {
    if (cached?.text === text) return cached.vec;
    try {
      const res = await this.ollama.embed({ model: this.model, input: text });
      return res.vectors[0] ?? hashVec(text);
    } catch {
      return hashVec(text);
    }
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    const n = Math.min(a.length, b.length);
    a = a.slice(0, n);
    b = b.slice(0, n);
  }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / denom;
}

function hashVec(s: string, n = 64): number[] {
  const v = new Array(n).fill(0);
  for (let i = 0; i < s.length; i++) v[i % n] += s.charCodeAt(i);
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}
