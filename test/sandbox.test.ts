import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SANDBOX_DIR, sandboxedCommand, sandboxProfile, sandboxScript, sandboxUnavailable } from "../src/sandbox";

let root: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-mail-sandbox-"));
});
afterEach(() => {
	const script = sandboxScript(sandboxProfile(path.join(root, "home", "mail"), 7577));
	fs.rmSync(script, { force: true });
	fs.rmSync(`${script}.sb`, { force: true });
	fs.rmSync(root, { recursive: true, force: true });
});

function run(command: string): { code: number; output: string } {
	const result = Bun.spawnSync(["/bin/bash", "-c", sandboxedCommand(command, sandboxProfile(path.join(root, "home", "mail"), 7577))]);
	return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

test.skipIf(process.platform !== "linux" || sandboxUnavailable() !== undefined)(
	"on Linux the mailbox stays closed however it is reached, while everything beside it stays usable",
	() => {
		const mail = path.join(root, "home", "mail");
		const work = path.join(root, "home", "work");
		fs.mkdirSync(mail, { recursive: true });
		fs.mkdirSync(work);
		fs.writeFileSync(path.join(mail, "message.json"), "{}\n");
		fs.symlinkSync(mail, path.join(work, "shortcut"));

		// A symlink elsewhere doesn't lend its own access to the mailbox it points at.
		expect(run(`cat ${work}/shortcut/message.json`).code).not.toBe(0);
		expect(run(`echo '{}' > ${work}/shortcut/forged.json`).code).not.toBe(0);
		expect(fs.existsSync(path.join(mail, "forged.json"))).toBe(false);
		// The sandbox's own scripts can be read and run, not rewritten.
		expect(run(`echo x >> ${SANDBOX_DIR}/linux-helper.py`).code).not.toBe(0);
		// A directory that existed beside the mailbox when the command started is fully usable.
		const used = run(`echo 42 > ${work}/out && cat ${work}/out && mkdir ${work}/sub && rm -r ${work}/sub`);
		expect(used).toEqual({ code: 0, output: "42\n" });
	},
);
