import { expect, test } from "bun:test";
import { linuxPolicy, sandboxProfile, SANDBOXED } from "../src/sandbox";

test("linux policy names the mailbox, the sandbox directory and bind/listen", () => {
	const policy = linuxPolicy("/tmp/peer-mail-policy-root", 7577);
	expect(policy.deny.some(dir => dir.endsWith("peer-mail-policy-root") || dir.includes("peer-mail-policy-root"))).toBe(true);
	expect(policy.readonly.length).toBe(1);
	expect(policy.graphPort).toBe(7577);
	expect(policy.bind).toBeGreaterThan(0);
	expect(policy.listen).toBeGreaterThan(0);
	expect(policy.seccomp).toBeGreaterThan(0);
});

test("this machine has a sandbox profile", () => {
	expect(SANDBOXED).toBe(process.platform === "darwin" || process.platform === "linux");
	const profile = sandboxProfile("/tmp/peer-mail-policy-root", 7577);
	if (process.platform === "linux") {
		const parsed = JSON.parse(profile);
		expect(parsed.graphPort).toBe(7577);
		expect(parsed.deny.length).toBeGreaterThan(0);
	} else {
		expect(profile).toContain("(deny network-bind)");
		expect(profile).toContain("(deny network-inbound)");
	}
});
