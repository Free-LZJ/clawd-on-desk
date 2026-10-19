"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");
const { DSH_CMD_TEMPLATE } = require("./dsh-desktop-fixtures");

const discoveryScript = `
const { discoverDshDesktopSync } = require(process.env.CLAWD_DSH_INSTALLER);
const options = {
  platform: "win32",
  env: {},
  windowsRegistrySnapshot: {
    uninstall: [{ installLocation: process.env.CLAWD_DSH_APP_ROOT }],
    commandDirectory: null,
  },
};
function reportDiscovery() {
  console.log(discoverDshDesktopSync(options).status);
}
process.stdin.on("data", reportDiscovery);
reportDiscovery();
`;

test("Windows desktop discovery leaves the ASAR replaceable while Node and Electron stay alive", {
  skip: process.platform !== "win32",
  timeout: 30_000,
}, async (t) => {
  const tempRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, "clawd-dsh-file-lock-"));
  t.after(() => {
    assert.equal(path.dirname(root), tempRoot);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const appRoot = path.join(root, "DeepSeek Harness");
  const binDir = path.join(appRoot, "resources", "runtime", "cli", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(appRoot, "DeepSeek Harness.exe"), "exe");
  fs.writeFileSync(path.join(binDir, "dsh.cmd"), `${DSH_CMD_TEMPLATE.join("\r\n")}\r\n`);
  const sourceDir = path.join(root, "source");
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(sourceDir, "package.json"), '{"name":"dsh-lock-test"}');
  const sourceArchive = path.join(root, "source.asar");
  await require("@electron/asar").createPackage(sourceDir, sourceArchive);
  const archive = path.join(appRoot, "resources", "app.asar");

  for (const [name, executable] of [["Node", process.execPath], ["Electron", require("electron")]]) {
    await t.test(name, async (t) => {
      fs.copyFileSync(sourceArchive, archive);
      const child = spawn(executable, ["-e", discoveryScript], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          CLAWD_DSH_INSTALLER: path.resolve(__dirname, "../hooks/dsh-install.js"),
          CLAWD_DSH_APP_ROOT: appRoot,
        },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const exited = new Promise((resolve) => {
        child.once("exit", resolve);
        child.once("error", resolve);
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      const lines = createInterface({ input: child.stdout });
      t.after(async () => {
        child.kill();
        await exited;
        lines.close();
      });
      const nextStatus = async () => {
        const [line] = await once(lines, "line", { signal: AbortSignal.timeout(10_000) });
        assert.equal(child.exitCode, null, stderr);
        assert.equal(child.signalCode, null, stderr);
        return line;
      };
      assert.equal(await nextStatus(), "found", stderr);

      const previous = `${archive}.previous`;
      fs.renameSync(archive, previous);
      fs.copyFileSync(sourceArchive, archive);
      fs.unlinkSync(previous);
      const rediscovered = nextStatus();
      child.stdin.write("recheck\n");
      assert.equal(await rediscovered, "found", stderr);

      fs.unlinkSync(archive);
      const missing = nextStatus();
      child.stdin.write("recheck\n");
      assert.equal(await missing, "not-found", stderr);
    });
  }
});
