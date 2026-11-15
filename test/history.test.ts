import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub.ts";
import { replay } from "../src/replay.ts";

// Exercise real saved files: a failed measurement may export usable files; a crashed probe may not.
test("history hides future evidence and waits for usable producer outputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "witness-history-"));
  const hub = await Hub.open(root, { pollMs: 0 });
  const head = '# /// script\n# dependencies = []\n# ///\nimport json, os, time\ntime.sleep(0.1)\n';
  const save = (name: string) => `json.dump(1, open(os.path.join(os.environ['WITNESS_OUT'], '${name}'), 'w'))\n`;
  const result = 'print("WITNESS_RESULT", json.dumps({"value": 1}))\n';
  const firstGoal = hub.goal("The copied value is one.");
  const producer = await hub.ask({ text: "Is the source value one?", rule: "$value = 1", probe: head + save("value.json") + result, waitS: 0 });
  const laterGoal = hub.goal("Another contract remains open.");
  const copy = (up: string, name: string) => ({ inputs: [`${up}/${name}`], rule: "$value = 1", probe: head + `value=json.load(open('${up}/${name}'))\nprint('WITNESS_RESULT', json.dumps({'value': value}))\n`, waitS: 0 });
  const acceptance = await hub.ask({ ...copy(producer.id, "value.json"), text: "Is the copied value one?", accepts: firstGoal.id });
  await hub.idle();
  const crash = await hub.ask({ text: "Does the crashed producer measure?", rule: "$value = 1", probe: head + save("value.json") + 'raise RuntimeError("broken")\n' + result, waitS: 0 });
  const blocked = await hub.ask({ ...copy(crash.id, "value.json"), text: "Can the crashed output be consumed?" });
  const missing = await hub.ask({ text: "Does the producer measure without the requested file?", rule: "$value = 1", probe: head + save("other.json") + result, waitS: 0 });
  const noFile = await hub.ask({ ...copy(missing.id, "value.json"), text: "Can the absent named file be consumed?" });
  const measured = await hub.ask({ text: "Does the measured producer satisfy its missing rule value?", rule: "$absent = 1", probe: head + save("value.json") + result, waitS: 0 });
  const usable = await hub.ask({ ...copy(measured.id, "value.json"), text: "Can a measured rule failure export a usable file?" });
  await hub.idle();
  const { rows } = hub.query('MATCH (q:Question) OPTIONAL MATCH (r:Run)-[:OF]->(q) RETURN q.id AS id, q.seq AS questionSeq, r.seq AS runSeq');
  const at = (id: string) => rows.find((r) => r.id === id)!;
  hub.close();
  const server = replay(root, { port: 0 });
  try {
    await using view = new Bun.WebView({ width: 1100, height: 800 });
    await view.navigate(server.url.href);
    for (let i = 0; i < 100; i++) {
      if (await view.evaluate("window.witness?.questions() === 8").catch(() => false)) break;
      await Bun.sleep(50);
    }
    const state = (id: string) => view.evaluate(`window.witness.state(${JSON.stringify(id)})`);
    const step = (n: number | null) => view.evaluate(`window.witness.setSeq(${n})`);
    const call = (name: string, args: object) => view.evaluate(`window.witness.tools.find(t => t.name === ${JSON.stringify(name)}).execute(${JSON.stringify(args)}).then(JSON.parse)`);
    expect(await state(blocked.id)).toBe("waiting");
    expect(await state(noFile.id)).toBe("waiting");
    expect(await state(usable.id)).toBe("yes");

    // Populate hover and Back with future questions before rewinding.
    await call("show_question", { id: producer.id });
    await call("show_question", { id: acceptance.id });
    await view.evaluate(`document.querySelector('[data-id="${acceptance.id}"]').dispatchEvent(new PointerEvent('pointerenter'))`);
    await step(1);
    expect(await view.evaluate("document.querySelector('#question').textContent")).toBe(firstGoal.text + "No acceptance question.");
    expect(await view.evaluate("document.querySelector('#hover-bar').textContent")).not.toContain(acceptance.question);
    expect(await view.evaluate("document.getElementById('evidence-back').hidden")).toBe(true);
    expect(await view.evaluate("[...document.querySelectorAll('#goal option')].map(o => o.value)")).toEqual(["", firstGoal.id]);
    expect(await call("show_question", { id: acceptance.id })).toHaveProperty("refused");
    expect(await call("query", { cypher: "RETURN $selected AS selected" })).toHaveProperty("refused");
    expect(await call("query", { cypher: "RETURN size($current) AS runs" })).toMatchObject({ rows: [{ runs: 0 }] });
    // Even a stale graph event must not re-open the future question.
    await view.evaluate(`document.querySelector('[data-id="${acceptance.id}"]').dispatchEvent(new MouseEvent('click', {bubbles:true}))`);
    expect(await view.evaluate("document.querySelector('#question').textContent")).not.toContain(acceptance.question);

    await step(Number(at(acceptance.id).questionSeq));
    expect(await state(acceptance.id)).toBe("waiting");
    expect(await call("show_question", { id: producer.id })).toMatchObject({ usedBy: [acceptance.id] });
    await step(Number(at(producer.id).runSeq));
    expect(await state(acceptance.id)).toBe("pending");
    await step(Number(at(acceptance.id).runSeq));
    expect(await state(acceptance.id)).toBe("yes");

    await step(Number(at(crash.id).runSeq) - 1);
    expect(await state(blocked.id)).toBe("waiting");
    await step(Number(at(crash.id).runSeq));
    expect(await call("show_question", { id: blocked.id })).toMatchObject({ answer: "waiting", ran: false, reason: expect.stringContaining("did not measure") });
    await step(Number(at(missing.id).runSeq));
    expect(await call("show_question", { id: noFile.id })).toMatchObject({ answer: "waiting", reason: expect.stringContaining("saved no file named value.json") });
    await step(Number(at(measured.id).runSeq));
    expect(await state(measured.id)).toBe("failed");
    expect(await state(usable.id)).toBe("pending");
    await step(null);
    expect(await state(usable.id)).toBe("yes");
    expect(await view.evaluate("document.querySelectorAll('#goal option').length")).toBe(3);
    expect(await view.evaluate(`document.querySelector('#goal option[value="${laterGoal.id}"]') !== null`)).toBe(true);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
