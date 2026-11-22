// Runs one probe command and waits for it. src/probe.ts starts this with `bun --no-orphans`, so the probe never
// outlives the hub: when the hub dies, even by SIGKILL, Bun exits this process and SIGKILLs every process the probe
// started. When the probe ends, the same flag kills anything it left running.
const child = Bun.spawn(process.argv.slice(2), { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
const code = await child.exited;
// A probe stopped by a signal stops this process with the same signal, so the hub reports which one.
if (child.signalCode) process.kill(process.pid, child.signalCode);
process.exit(code);
