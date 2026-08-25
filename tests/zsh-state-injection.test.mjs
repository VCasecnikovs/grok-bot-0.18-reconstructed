import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

// Regression: local Mac shell commands completed with `dump_zsh_state: command not found` on 2026-08-25.
test("stateful zsh executions inject the dump function before invoking it", async () => {
  const source = await readFile(path.join(root, "source/packages/shell-exec/zsh.ts"), "utf8");
  assert.match(source, /\$\{dumpZshState\} builtin eval "\$snap"[\s\S]+dump_zsh_state >&4/);
});
