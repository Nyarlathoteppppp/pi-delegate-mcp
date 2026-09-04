import assert from "node:assert/strict";

process.env.PI_DELEGATE_MODEL_ALLOWLIST = "test/fast,test/smart";
process.env.PI_DELEGATE_MAX_CONCURRENT = "2";

const { MAX_CONCURRENT, MODEL_ALLOWLIST } = await import("../dist/config.js");
const { inDelegateAllowlist } = await import("../dist/pi/models.js");
const { assertCapacity } = await import("../dist/registry.js");

assert.equal(MAX_CONCURRENT, 2);
assert.deepEqual([...MODEL_ALLOWLIST], ["test/fast", "test/smart"]);
assert.equal(inDelegateAllowlist("test", "fast"), true);
assert.equal(inDelegateAllowlist("test", "other"), false);
assert.doesNotThrow(() => assertCapacity(2));
assert.throws(() => assertCapacity(3), /concurrency limit is 2/);

console.log("  OK -> delegate model allowlist and global concurrency policy");
