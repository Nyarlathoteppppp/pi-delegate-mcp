import assert from "node:assert/strict";

process.env.PI_DELEGATE_MODEL_ALLOWLIST = "test/fast,test/smart";
const { BATCH_MAX, MAX_CONCURRENT, MODEL_ALLOWLIST } = await import("../dist/config.js");
const { inDelegateAllowlist } = await import("../dist/pi/models.js");
const { assertCapacity } = await import("../dist/registry.js");

assert.equal(BATCH_MAX, 4);
assert.equal(MAX_CONCURRENT, 4);
assert.deepEqual([...MODEL_ALLOWLIST], ["test/fast", "test/smart"]);
assert.equal(inDelegateAllowlist("test", "fast"), true);
assert.equal(inDelegateAllowlist("test", "other"), false);
assert.doesNotThrow(() => assertCapacity(4));
assert.throws(() => assertCapacity(5), /concurrency limit is 4/);

console.log("  OK -> delegate model allowlist and global concurrency policy");
