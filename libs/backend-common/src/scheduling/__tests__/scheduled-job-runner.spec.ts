import {
  ScheduledJobRunner,
  type LeaseConnection,
  type ScheduledJobHeartbeat,
} from '../scheduled-job-runner.service';
import { clearScheduledJobRegistry, registerScheduledJobName } from '../scheduled-job.registry';

/**
 * ADMIN-HIGH-013 — one replica runs a tick, every tick is heartbeated, and
 * the lock lives exactly as long as the transaction that took it.
 */
class FakeHeartbeat implements ScheduledJobHeartbeat {
  readonly tracked: string[] = [];
  readonly skipped: string[] = [];
  readonly declared: string[] = [];

  declare(job: string): void {
    this.declared.push(job);
  }

  recordSkipped(job: string): void {
    this.skipped.push(job);
  }

  async track<T>(job: string, body: () => Promise<T>): Promise<T> {
    this.tracked.push(job);
    return body();
  }
}

interface Fixture {
  runner: ScheduledJobRunner;
  queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    query: jest.Mock;
  };
  heartbeat: FakeHeartbeat;
}

function fixture(locked: boolean): Fixture {
  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([{ locked }]),
  };
  const heartbeat = new FakeHeartbeat();
  const connection: LeaseConnection = queryRunner;
  const runner = new ScheduledJobRunner(
    { serviceName: 'admin-api-service' },
    { createQueryRunner: () => connection },
    heartbeat,
  );
  return { runner, queryRunner, heartbeat };
}

describe('ScheduledJobRunner', () => {
  afterEach(() => clearScheduledJobRegistry());

  it('runs the body through the heartbeat when it wins the advisory lock, then rolls back and releases', async () => {
    const { runner, queryRunner, heartbeat } = fixture(true);
    const body = jest.fn().mockResolvedValue(undefined);

    await expect(runner.run('jobs.sweep', body)).resolves.toBe('ran');

    expect(queryRunner.connect).toHaveBeenCalledTimes(1);
    expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_try_advisory_xact_lock(hashtext($1), hashtext($2))'),
      ['admin-api-service', 'jobs.sweep'],
    );
    expect(heartbeat.tracked).toEqual(['jobs.sweep']);
    expect(body).toHaveBeenCalledTimes(1);
    expect(heartbeat.skipped).toEqual([]);
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('skips the body and records the skip when another replica holds the lock', async () => {
    const { runner, queryRunner, heartbeat } = fixture(false);
    const body = jest.fn().mockResolvedValue(undefined);

    await expect(runner.run('jobs.sweep', body)).resolves.toBe('skipped');

    expect(body).not.toHaveBeenCalled();
    expect(heartbeat.tracked).toEqual([]);
    expect(heartbeat.skipped).toEqual(['jobs.sweep']);
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('re-throws a failing body after releasing the lock connection', async () => {
    const { runner, queryRunner } = fixture(true);
    const body = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(runner.run('jobs.sweep', body)).rejects.toThrow('boom');

    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('runs each-replica jobs on every replica without taking a lock, still heartbeated', async () => {
    const { runner, queryRunner, heartbeat } = fixture(false);
    const body = jest.fn().mockResolvedValue(undefined);

    await expect(runner.run('cache.sweep', body, 'each-replica')).resolves.toBe('ran');

    expect(queryRunner.connect).not.toHaveBeenCalled();
    expect(heartbeat.tracked).toEqual(['cache.sweep']);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('declares every registered job at boot so "never ran" is a value, not a missing series', () => {
    registerScheduledJobName('b.job', 'B#run');
    registerScheduledJobName('a.job', 'A#run');
    const { runner, heartbeat } = fixture(true);

    runner.onModuleInit();

    expect(heartbeat.declared).toEqual(['a.job', 'b.job']);
  });
});
