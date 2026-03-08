/**
 * Lightweight promise-based semaphore for controlling parallel API calls.
 * Zero external dependencies.
 */

export function createSemaphore(concurrency: number) {
  if (concurrency < 1) throw new Error("Concurrency must be >= 1");

  let running = 0;
  const queue: Array<() => void> = [];

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    running++;
    try {
      return await fn();
    } finally {
      running--;
      const next = queue.shift();
      if (next) next();
    }
  }

  return { run };
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export function getConcurrencyLimit(): number {
  const env = process.env["GMAIL_MCP_CONCURRENCY"];
  const parsed = env !== undefined ? parseInt(env, 10) : NaN;
  return isNaN(parsed) || parsed < 1 ? 5 : parsed;
}
