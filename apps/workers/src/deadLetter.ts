import type { Job, Queue, Worker } from 'bullmq';

// HLD §8: every BullMQ queue has a `<queue-name>-failed` dead-letter queue, reviewed on the integration
// health screen. When a job fails for the last time, its payload is copied there. Only the payload goes
// (ids the job already carried) — never the error message, which can echo SQL parameters or hashes.

export function attachDeadLetter<T extends object>(
  worker: Worker<T>,
  deadLetterQueue: Pick<Queue<T>, 'add'>,
  log: (line: Record<string, unknown>) => void,
): void {
  worker.on('failed', (job: Job<T> | undefined, error: Error) => {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return; // it will be retried
    log({
      event: 'job_dead_lettered',
      queue: job.queueName,
      job_id: job.id,
      error_name: error.name,
    });
    // Typed loosely: BullMQ's `add` wants its own NameType/data generics, and the payload is what we copy.
    void (deadLetterQueue as Pick<Queue, 'add'>).add(job.name, job.data).catch(() => undefined);
  });
}
