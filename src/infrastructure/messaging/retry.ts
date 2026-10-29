export function backoffSeconds(attempt: number, base: number, cap: number, random = Math.random): number {
  const ceiling = Math.min(cap, base * 2 ** Math.min(30, Math.max(0, attempt - 1)));
  // Equal jitter avoids zero-delay hot loops, even for the first attempt.
  return Math.max(1, Math.ceil(ceiling / 2 + random() * ceiling / 2));
}
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
