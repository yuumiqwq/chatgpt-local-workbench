import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

test("read_host_file preserves identical structured and text pages through stdio JSON-RPC", async t => {
  const scratch = resolve("codex-generated/read-host-file-tests");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "case-"));
  const configPath = join(root, "workspaces.json");
  const client = new Client({ name: "read-host-file-regression", version: "1" });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(configPath, "[]");
  await writeFile(configPath + ".host-policy.json", JSON.stringify({
    version: 1, enabled: true, read_roots: [root]
  }));
  const fixtures = [
    { name: "README.md", bytes: Buffer.from("# Read test\n" + "中文🙂".repeat(100)), encoding: "utf8", max_bytes: 512 },
    { name: ".editorconfig", bytes: Buffer.from([0, 255, 128, 13, 10, 65]), encoding: "base64", max_bytes: 256 },
    { name: "large.bin", bytes: Buffer.alloc(262_151, 255), encoding: "base64", max_bytes: 262_144 },
    { name: "大一下期末复习.txt", bytes: Buffer.from("\uFEFF复习安排\r\n".repeat(60)), encoding: "utf8", max_bytes: 31,
      include_sha256: true },
    { name: "empty.txt", bytes: Buffer.alloc(0), encoding: "utf8", max_bytes: 512 }
  ];
  for (const fixture of fixtures) await writeFile(join(root, fixture.name), fixture.bytes);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../../../src/mcp-stdio.js", import.meta.url)), configPath], stderr: "pipe" });
  await client.connect(transport);
  const wire: JSONRPCMessage[] = [];
  const receive = transport.onmessage;
  transport.onmessage = message => { wire.push(message); receive?.(message); };
  const tool = (await client.listTools()).tools.find(tool => tool.name === "read_host_file");
  assert.ok(tool, "the file reader must be discoverable");

  for (const fixture of fixtures) await t.test(fixture.name, async () => {
    let offset = 0;
    const chunks: Buffer[] = [];
    for (;;) {
      const result = CallToolResultSchema.parse(await client.callTool({ name: "read_host_file", arguments: {
        path: join(root, fixture.name), encoding: fixture.encoding, max_bytes: fixture.max_bytes,
        offset, include_sha256: fixture.include_sha256 ?? false
      } }));
      assert.notEqual(result.isError, true);
      assert.equal(result.content.length, 1);
      const block = result.content[0]!;
      assert.equal(block.type, "text");
      assert.ok(block.type === "text");
      const body = JSON.parse(block.text);
      assert.deepEqual(result.structuredContent, body);
      const envelope = wire.at(-1)!;
      assert.ok("result" in envelope);
      assert.deepEqual(envelope.result, result);
      assert.equal(body.path, join(root, fixture.name));
      assert.equal(body.encoding, fixture.encoding);
      assert.equal(body.size, fixture.bytes.length);
      assert.equal(body.offset, offset);
      assert.equal(body.next_offset, offset + body.bytes_read);
      assert.ok(body.bytes_read <= fixture.max_bytes);
      const chunk = Buffer.from(body.content, fixture.encoding as BufferEncoding);
      assert.equal(chunk.length, body.bytes_read);
      assert.deepEqual(chunk, fixture.bytes.subarray(offset, body.next_offset));
      chunks.push(chunk);
      if (fixture.include_sha256) {
        assert.equal(body.sha256, createHash("sha256").update(fixture.bytes).digest("hex"));
      } else assert.equal("sha256" in body, false);
      if (!body.truncated) { assert.equal(body.next_offset, body.size); break; }
      assert.ok(body.next_offset > offset);
      offset = body.next_offset;
    }
    assert.deepEqual(Buffer.concat(chunks), fixture.bytes);
  });

  await t.test("concurrent reads retain their own file pages", async () => {
    await Promise.all(fixtures.map(async fixture => {
      const result = CallToolResultSchema.parse(await client.callTool({ name: "read_host_file", arguments: {
        path: join(root, fixture.name), encoding: fixture.encoding, max_bytes: fixture.max_bytes
      } }));
      assert.notEqual(result.isError, true);
      const block = result.content[0]!;
      assert.ok(block.type === "text");
      const body = JSON.parse(block.text);
      assert.deepEqual(result.structuredContent, body);
      assert.equal(body.path, join(root, fixture.name));
      assert.deepEqual(Buffer.from(body.content, fixture.encoding as BufferEncoding),
        fixture.bytes.subarray(0, body.next_offset));
    }));
  });

  await t.test("missing files remain tool errors with a readable text body", async () => {
    const result = CallToolResultSchema.parse(await client.callTool({ name: "read_host_file",
      arguments: { path: join(root, "missing.txt") } }));
    assert.equal(result.isError, true);
    const block = result.content[0]!;
    assert.ok(block.type === "text");
    assert.equal(JSON.parse(block.text).error.code, "HOST_OPERATION_FAILED");
    assert.equal(result.structuredContent, undefined);
  });
  const audit = await readFile(configPath + ".host-policy.json.audit.jsonl", "utf8");
  assert.equal(audit.includes("# Read test"), false);
  assert.equal(audit.includes('"state":"failed"'), true);
});
