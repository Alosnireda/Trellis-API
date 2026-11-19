import { SyntheticMonitoringService, Journey } from './synthetic-monitoring.service';

const makeJourney = (steps: Array<{ name: string; fn: () => Promise<void> }>): Journey => ({
  name: 'test-journey',
  steps,
});

describe('SyntheticMonitoringService', () => {
  let svc: SyntheticMonitoringService;

  beforeEach(() => {
    svc = new SyntheticMonitoringService();
  });

  it('passes when all steps succeed', async () => {
    svc.register(makeJourney([
      { name: 'login', fn: async () => {} },
      { name: 'fetch-data', fn: async () => {} },
    ]));
    const result = await svc.run('test-journey');
    expect(result.passed).toBe(true);
    expect(result.steps.every(s => s.status === 'pass')).toBe(true);
  });

  it('fails and skips subsequent steps when a step throws', async () => {
    svc.register(makeJourney([
      { name: 'login', fn: async () => { throw new Error('auth failed'); } },
      { name: 'fetch-data', fn: async () => {} },
    ]));
    const result = await svc.run('test-journey');
    expect(result.passed).toBe(false);
    expect(result.steps[0].status).toBe('fail');
    expect(result.steps[0].error).toContain('auth failed');
    expect(result.steps[1].status).toBe('skip');
  });

  it('throws for unknown journey', async () => {
    await expect(svc.run('nonexistent')).rejects.toThrow('Unknown journey');
  });

  it('runs all journeys via runAll', async () => {
    svc.register({ name: 'j1', steps: [{ name: 's1', fn: async () => {} }] });
    svc.register({ name: 'j2', steps: [{ name: 's1', fn: async () => {} }] });
    const results = await svc.runAll();
    expect(results).toHaveLength(2);
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('marks remaining steps as skip when signal is aborted', async () => {
    const controller = new AbortController();
    svc.register(makeJourney([
      { name: 'step1', fn: async () => { controller.abort(); } },
      { name: 'step2', fn: async () => {} },
    ]));
    const result = await svc.run('test-journey', controller.signal);
    expect(result.steps[1].status).toBe('skip');
  });

  it('records duration for each step', async () => {
    svc.register(makeJourney([
      { name: 'slow-step', fn: async () => { await new Promise(r => setTimeout(r, 10)); } },
    ]));
    const result = await svc.run('test-journey');
    expect(result.steps[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('overwrites journey on re-register', async () => {
    svc.register({ name: 'j', steps: [{ name: 's1', fn: async () => { throw new Error(); } }] });
    svc.register({ name: 'j', steps: [{ name: 's1', fn: async () => {} }] });
    const result = await svc.run('j');
    expect(result.passed).toBe(true);
  });

  it('reports ranAt timestamp', async () => {
    svc.register(makeJourney([{ name: 's', fn: async () => {} }]));
    const before = Date.now();
    const result = await svc.run('test-journey');
    expect(result.ranAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});
