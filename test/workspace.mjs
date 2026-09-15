import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { blockedSecretPath } from "../dist/secrets.js";
import { resolveDelegateCwd } from "../dist/workspace.js";

await assert.rejects(() => resolveDelegateCwd(undefined), /cwd is required/);
await assert.rejects(() => resolveDelegateCwd("."), /absolute/);
await assert.rejects(() => resolveDelegateCwd("/"), /filesystem root/);
await assert.rejects(() => resolveDelegateCwd(homedir()), /home directory/);
const tmp = await resolveDelegateCwd("/tmp");
assert.ok(tmp.startsWith("/"));

const home = homedir();
assert.ok(blockedSecretPath(join(home, ".codex", "auth.json"), "/tmp"));
assert.ok(blockedSecretPath(join(home, ".ssh", "id_rsa"), "/tmp"));
assert.ok(blockedSecretPath(join(home, ".grok", "auth.json"), "/tmp"));
assert.ok(blockedSecretPath(join(home, ".pi", "agent", "auth.json"), "/tmp"));
assert.ok(blockedSecretPath(join("/tmp", ".env"), "/tmp"));
assert.equal(blockedSecretPath(join("/tmp", "README.md"), "/tmp"), undefined);

console.log("  OK -> cwd and secret-path guards");
