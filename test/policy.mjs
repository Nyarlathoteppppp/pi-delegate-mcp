import assert from "node:assert/strict";

process.env.PI_DELEGATE_MODEL_ALLOWLIST = "test/fast,test/smart";
const {
  BATCH_MAX,
  MAX_CONCURRENT,
  MAX_TURNS,
  MAX_DURATION_MS,
  RUN_DEFAULT_TURNS,
  RUN_DEFAULT_DURATION_MS,
  SPAWN_DEFAULT_TURNS,
  SPAWN_DEFAULT_DURATION_MS,
  MODEL_ALLOWLIST,
} = await import("../dist/config.js");
const { inDelegateAllowlist } = await import("../dist/pi/models.js");
const { assertCapacity } = await import("../dist/registry.js");

assert.equal(BATCH_MAX, 4);
assert.equal(MAX_CONCURRENT, 4);
assert.equal(MAX_TURNS, 50);
assert.equal(MAX_DURATION_MS, 900_000);
assert.equal(RUN_DEFAULT_TURNS, 12);
assert.equal(RUN_DEFAULT_DURATION_MS, 300_000);
assert.equal(SPAWN_DEFAULT_TURNS, 30);
assert.equal(SPAWN_DEFAULT_DURATION_MS, 600_000);
assert.deepEqual([...MODEL_ALLOWLIST], ["test/fast", "test/smart"]);
assert.equal(inDelegateAllowlist("test", "fast"), true);
assert.equal(inDelegateAllowlist("test", "other"), false);
assert.doesNotThrow(() => assertCapacity(4));
assert.throws(() => assertCapacity(5), /concurrency limit is 4/);

console.log("  OK -> delegate model allowlist and global concurrency policy");
