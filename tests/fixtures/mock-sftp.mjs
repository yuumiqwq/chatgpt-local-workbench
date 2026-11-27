// Offline process fixture: consumes the real generated SFTP batch on stdin.
import { writeFile, appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const mode = process.argv[2];
let batch = "";
for await (const chunk of process.stdin) batch += chunk;
if (!/^get "[^"\r\n]+" "payload"\nquit\n$/u.test(batch)) process.exit(3);
if (mode === "failure") { process.stderr.write("PRIVATE_DIAGNOSTIC_MUST_NOT_ESCAPE"); process.exit(7); }
if (mode === "tree") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "inherit" });
  process.stdout.write(`CHILD_PID=${child.pid}\n`);
  setInterval(() => {}, 1000);
}
else if (mode === "output") { process.stderr.write("x".repeat(100_000)); setInterval(() => {}, 1000); }
else if (mode === "hang") { await writeFile("payload", "partial"); setInterval(() => {}, 1000); }
else if (mode === "grow") {
  setInterval(() => { void appendFile("payload", Buffer.alloc(4096)); }, 10);
} else await writeFile("payload", Buffer.from("verified transfer\0数据", "utf8"));
