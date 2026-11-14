// Explicit remeasurement appends executions without changing the test or erasing its evidence.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/hub.ts';

let root: string;
let hub: Hub;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'witness-rerun-'));
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

// External state intentionally stands in for transient failures and noisy measurements not represented in the key.
const externalProbe = () => head + `x = int(open(${JSON.stringify(join(root, 'external.txt'))}).read())
assert x != 0, 'transient failure'
open(os.path.join(os.environ['WITNESS_OUT'], 'x.txt'), 'w').write(str(x))
print('WITNESS_RESULT', json.dumps({'x': x}))`;

async function settle() {
  for (let i = 0; i < 20; i++) {
    hub.check(); await hub.idle();
    if (!hub.statuses().some(s => s.state === 'pending' || s.state === 'running')) return;
  }
  throw new Error('questions did not settle');
}

test('rerun appends on the same key, preserves the question and old files, and replaces the cached answer', async () => {
  writeFileSync(join(root, 'external.txt'), '1');
  const a = { ...question, probe: externalProbe(), asker: 'first' };
  const first = await hub.ask(a);
  const original = hub.query('MATCH (q:Question {id: $id}) RETURN properties(q) AS q', { id: first.id }).rows;
  writeFileSync(join(root, 'external.txt'), '-2');
  expect((await hub.ask(a)).run).toBe(first.run);
  const second = await hub.ask({ ...a, rerun: true, asker: 'retry' });
  expect(second.id).toBe(first.id);
  expect(second.run).not.toBe(first.run);
  expect(second.state).toBe('no');
  expect(second.results).toEqual([{ x: -2 }]);
  expect(hub.query('MATCH (q:Question {id: $id}) RETURN properties(q) AS q', { id: first.id }).rows).toEqual(original);
  expect(hub.query('MATCH (r:Run) RETURN count(DISTINCT r.key) AS keys').rows).toEqual([{ keys: 1 }]);
  expect(runs()).toBe(2);
  expect(readFileSync(hub.look(`${first.run}/x.txt`).path, 'utf8')).toBe('1');
  expect(readFileSync(hub.look(`${second.id}/x.txt`).path, 'utf8')).toBe('-2');
  expect((await hub.ask(a)).run).toBe(second.run);
  await hub.idle(); hub.close();
  hub = await Hub.open(root, { pollMs: 0, jobs: 1 });
  expect((await hub.ask(a)).run).toBe(second.run);
  expect(runs()).toBe(2);
}, 30_000);

test('a cached failure can be retried, and a later failure does not fall back to an older yes', async () => {
  writeFileSync(join(root, 'external.txt'), '0');
  const a = { ...question, probe: externalProbe() };
  const failed = await hub.ask(a);
  expect(failed.state).toBe('failed');
  writeFileSync(join(root, 'external.txt'), '1');
  expect((await hub.ask(a)).run).toBe(failed.run);
  const recovered = await hub.ask({ ...a, rerun: true });
  expect([recovered.id, recovered.state]).toEqual([failed.id, 'yes']);
  writeFileSync(join(root, 'external.txt'), '0');
  const failedAgain = await hub.ask({ ...a, rerun: true });
  expect(failedAgain.state).toBe('failed');
  expect((await hub.ask(a)).run).toBe(failedAgain.run);
  expect(runs()).toBe(3);
}, 30_000);

test('restoring declared inputs restores their latest run, including an explicit rerun', async () => {
  writeFileSync(join(root, 'data.txt'), '1');
  writeFileSync(join(root, 'external.txt'), '0');
  const a = { ...question, inputs: ['data.txt'], probe: head + `x = int(open('data.txt').read()) + int(open(${JSON.stringify(join(root, 'external.txt'))}).read())\nprint('WITNESS_RESULT', json.dumps({'x': x}))` };
  const first = await hub.ask(a);
  writeFileSync(join(root, 'data.txt'), '-2');
  const other = await hub.ask(a);
  writeFileSync(join(root, 'data.txt'), '1');
  expect((await hub.ask(a)).run).toBe(first.run);
  writeFileSync(join(root, 'external.txt'), '-4');
  const newer = await hub.ask({ ...a, rerun: true });
  expect(newer.state).toBe('no');
  writeFileSync(join(root, 'data.txt'), '-2');
  expect((await hub.ask(a)).run).toBe(other.run);
  writeFileSync(join(root, 'data.txt'), '1');
  expect((await hub.ask(a)).run).toBe(newer.run);
  expect(runs()).toBe(3);
}, 30_000);

test('rerun on a new question runs once, and concurrent reruns join the active execution', async () => {
  const a = { ...question, probe: question.probe + '\nimport time\ntime.sleep(0.2)', waitS: 0 };
  const first = await hub.ask({ ...a, rerun: true });
  const joined = await hub.ask({ ...a, rerun: true });
  expect([first.state, joined.state]).toEqual(['running', 'running']);
  expect(joined.run).toBe(first.run);
  await hub.idle();
  expect(runs()).toBe(1);
  const [second, concurrent, ordinary] = await Promise.all([
    hub.ask({ ...a, rerun: true }), hub.ask({ ...a, rerun: true }), hub.ask(a),
  ]);
  expect(second.run).not.toBe(first.run);
  expect(new Set([second.run, concurrent.run, ordinary.run]).size).toBe(1);
  await hub.idle();
  expect(runs()).toBe(2);
}, 30_000);

test('queued reruns respect worker capacity and coalesce before they start', async () => {
  const first = await hub.ask(question);
  const blocker = await hub.ask({ ...question, text: 'Does the other worker finish?', probe: question.probe + '\nimport time\ntime.sleep(0.2)', waitS: 0 });
  const [queued, duplicate] = await Promise.all([
    hub.ask({ ...question, rerun: true, waitS: 0 }), hub.ask({ ...question, rerun: true, waitS: 0 }),
  ]);
  expect([queued.id, duplicate.id]).toEqual([first.id, first.id]);
  expect([queued.state, duplicate.state]).toEqual(['pending', 'pending']);
  expect(hub.status(blocker.id).state).toBe('running');
  await settle();
  expect(hub.status(first.id).run).not.toBe(first.run);
  expect(runs()).toBe(3);
}, 30_000);

test('rerunning acceptance retains its binding and makes completion wait for the new result', async () => {
  const g = hub.goal('x is positive');
  const a = { ...question, accepts: g.id, probe: question.probe + '\nimport time\ntime.sleep(0.2)' };
  const first = await hub.ask(a);
  const pending = await hub.ask({ ...a, rerun: true, waitS: 0 });
  expect([pending.id, pending.state]).toEqual([first.id, 'running']);
  expect(pending.goal).toMatchObject({ acceptance: first.id, complete: false });
  await hub.idle();
  expect((await hub.ask(a)).goal).toMatchObject({ acceptance: first.id, complete: true });
  expect(hub.query('MATCH (:Goal)-[:ACCEPTED_BY]->(:Question) RETURN count(*) AS n').rows).toEqual([{ n: 1 }]);
  expect(runs()).toBe(2);
}, 30_000);

test('a rerun waits for upstream inputs; downstream reruns only when saved bytes change', async () => {
  writeFileSync(join(root, 'external.txt'), '1');
  const producer = { ...question, probe: externalProbe() + '\nimport time\ntime.sleep(0.15)' };
  const first = await hub.ask(producer);
  const consumer = { ...question, text: 'Is the saved x positive?', inputs: [`${first.id}/x.txt`],
    probe: head + `print('WITNESS_RESULT', json.dumps({'x': int(open('${first.id}/x.txt').read())}))` };
  const initial = await hub.ask(consumer);
  await hub.ask({ ...producer, rerun: true });
  expect((await hub.ask(consumer)).run).toBe(initial.run);
  writeFileSync(join(root, 'external.txt'), '-2');
  await hub.ask({ ...producer, rerun: true, waitS: 0 });
  const waiting = await hub.ask({ ...consumer, rerun: true, waitS: 0 });
  expect(waiting.state).toBe('waiting');
  await settle();
  const changed = await hub.ask(consumer);
  expect(changed.state).toBe('no');
  expect(changed.run).not.toBe(initial.run);
  expect(runs()).toBe(5); // three producer executions and two consumer executions
}, 30_000);
