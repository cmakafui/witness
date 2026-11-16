// A run that measured is final for its inputs. A crash or a timeout settles nothing: asking again retries it.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/hub.ts';

let root: string;
let hub: Hub;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'witness-retry-'));
  hub = await Hub.open(root, { pollMs: 0, jobs: 1 });
});
afterEach(async () => {
  await hub.idle();
  hub.close();
  rmSync(root, { recursive: true, force: true });
});
const head = '# /// script\n# dependencies = []\n# ///\nimport json, os\n';
const question = { text: 'Is x positive?', rule: '$x > 0', probe: head + `print('WITNESS_RESULT', '{"x": 1}')` };
const runs = () => hub.query('MATCH (r:Run) RETURN count(r) AS n').rows[0]!.n;

// External state stands in for a transient failure that the key does not see. x = 0 crashes.
const externalProbe = (extra = '') => head + `x = int(open(${JSON.stringify(join(root, 'external.txt'))}).read())
assert x != 0, 'transient failure'${extra}
open(os.path.join(os.environ['WITNESS_OUT'], 'x.txt'), 'w').write(str(x))
print('WITNESS_RESULT', json.dumps({'x': x}))`;

async function settle() {
  for (let i = 0; i < 20; i++) {
    hub.check(); await hub.idle();
    if (!hub.statuses().some(s => s.state === 'pending' || s.state === 'running')) return;
  }
  throw new Error('questions did not settle');
}

test('a measured answer is final for its inputs, even when it is no or the rule fails', async () => {
  writeFileSync(join(root, 'external.txt'), '-2');
  const no = await hub.ask({ ...question, probe: externalProbe() });
  const undecided = await hub.ask({ ...question, text: 'Is y positive?', rule: '$y > 0', probe: externalProbe() });
  expect([no.state, undecided.state]).toEqual(['no', 'failed']);
  writeFileSync(join(root, 'external.txt'), '1');
  expect((await hub.ask({ ...question, probe: externalProbe() })).run).toBe(no.run);
  expect((await hub.ask({ ...question, text: 'Is y positive?', rule: '$y > 0', probe: externalProbe() })).run).toBe(undecided.run);
  await settle();
  expect(runs()).toBe(2);
}, 30_000);

test('a crash is not retried on its own; the same ask retries it on the same key and keeps the old run', async () => {
  writeFileSync(join(root, 'external.txt'), '0');
  const a = { ...question, probe: externalProbe(), asker: 'first' };
  const crashed = await hub.ask(a);
  expect(crashed.state).toBe('failed');
  writeFileSync(join(root, 'external.txt'), '1');
  await settle();
  expect(hub.status(crashed.id)).toMatchObject({ state: 'failed', run: crashed.run });
  expect(runs()).toBe(1);
  const original = hub.query('MATCH (q:Question {id: $id}) RETURN properties(q) AS q', { id: crashed.id }).rows;
  const retried = await hub.ask({ ...a, asker: 'second' });
  expect([retried.id, retried.state, retried.results]).toEqual([crashed.id, 'yes', [{ x: 1 }]]);
  expect(retried.run).not.toBe(crashed.run);
  expect(hub.query('MATCH (q:Question {id: $id}) RETURN properties(q) AS q', { id: crashed.id }).rows).toEqual(original);
  expect(hub.query('MATCH (r:Run) RETURN count(DISTINCT r.key) AS keys').rows).toEqual([{ keys: 1 }]);
  expect(readFileSync(hub.look(`${retried.id}/x.txt`).path, 'utf8')).toBe('1');
  writeFileSync(join(root, 'external.txt'), '0');
  expect((await hub.ask(a)).run).toBe(retried.run);
  await hub.idle(); hub.close();
  hub = await Hub.open(root, { pollMs: 0, jobs: 1 });
  expect((await hub.ask(a)).run).toBe(retried.run);
  expect(runs()).toBe(2);
}, 30_000);

test('restoring inputs restores a crash without retrying it', async () => {
  writeFileSync(join(root, 'data.txt'), '1');
  writeFileSync(join(root, 'external.txt'), '0');
  const a = { ...question, inputs: ['data.txt'], probe: externalProbe().replace("x = int(", "x = int(open('data.txt').read()) * int(") };
  const crashed = await hub.ask(a);
  expect(crashed.state).toBe('failed');
  writeFileSync(join(root, 'data.txt'), '2');
  writeFileSync(join(root, 'external.txt'), '1');
  expect((await hub.ask(a)).state).toBe('yes');
  writeFileSync(join(root, 'data.txt'), '1');
  await settle();
  expect(hub.status(crashed.id)).toMatchObject({ state: 'failed', run: crashed.run });
  expect((await hub.ask(a)).state).toBe('yes');
  expect(runs()).toBe(3);
}, 30_000);

test('concurrent asks of a crashed question join one retry, which waits for a worker', async () => {
  writeFileSync(join(root, 'external.txt'), '0');
  const a = { ...question, probe: externalProbe(), waitS: 0 };
  const crashed = await hub.ask({ ...a, waitS: 120 });
  writeFileSync(join(root, 'external.txt'), '1');
  const blocker = await hub.ask({ ...question, text: 'Does the other worker finish?', probe: question.probe + '\nimport time\ntime.sleep(0.2)', waitS: 0 });
  const [queued, duplicate] = await Promise.all([hub.ask(a), hub.ask(a)]);
  expect([queued.state, duplicate.state]).toEqual(['pending', 'pending']);
  expect(hub.status(blocker.id).state).toBe('running');
  await settle();
  expect(hub.status(crashed.id).state).toBe('yes');
  expect(runs()).toBe(3);
}, 30_000);

test('retrying a crashed acceptance question keeps its binding, and completion waits for the retry', async () => {
  writeFileSync(join(root, 'external.txt'), '0');
  const g = hub.goal('x is positive');
  const a = { ...question, accepts: g.id, probe: externalProbe('\nimport time\ntime.sleep(0.2)') };
  const crashed = await hub.ask(a);
  expect(crashed.goal).toMatchObject({ acceptance: crashed.id, complete: false });
  writeFileSync(join(root, 'external.txt'), '1');
  const running = await hub.ask({ ...a, waitS: 0 });
  expect([running.id, running.state]).toEqual([crashed.id, 'running']);
  expect(running.goal).toMatchObject({ complete: false });
  await hub.idle();
  expect((await hub.ask(a)).goal).toMatchObject({ acceptance: crashed.id, complete: true });
  expect(hub.query('MATCH (:Goal)-[:ACCEPTED_BY]->(:Question) RETURN count(*) AS n').rows).toEqual([{ n: 1 }]);
  expect(runs()).toBe(2);
}, 30_000);

test('a consumer of a crashed producer waits, says how to retry, and runs once the producer measures', async () => {
  writeFileSync(join(root, 'external.txt'), '0');
  const producer = { ...question, probe: externalProbe() };
  const crashed = await hub.ask(producer);
  const consumer = { ...question, text: 'Is the saved x positive?', inputs: [`${crashed.id}/x.txt`],
    probe: head + `print('WITNESS_RESULT', json.dumps({'x': int(open('${crashed.id}/x.txt').read())}))` };
  const waiting = await hub.ask(consumer);
  expect(waiting.state).toBe('waiting');
  expect(waiting.reason).toContain(`Ask ${crashed.id} again`);
  writeFileSync(join(root, 'external.txt'), '1');
  await hub.ask(producer);
  await settle();
  expect((await hub.ask(consumer)).state).toBe('yes');
  expect(runs()).toBe(3);
}, 30_000);
