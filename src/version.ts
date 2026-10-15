/**
 * Which peer-mail code a session runs: a hash of the plugin's source files. Running sessions keep
 * the code they loaded, so comparing their hash with the files on disk shows who needs a restart.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SOURCE_DIR = path.dirname(new URL(import.meta.url).pathname);

/** A short hash of the source files as they are on disk now. */
export function codeVersion(): string {
	const hash = createHash("sha256");
	for (const file of fs.readdirSync(SOURCE_DIR).sort()) {
		if (!/\.(ts|html)$/.test(file)) continue;
		hash.update(file);
		hash.update(fs.readFileSync(path.join(SOURCE_DIR, file)));
	}
	return hash.digest("hex").slice(0, 8);
}

/** The code this process loaded. */
export const LOADED_VERSION = codeVersion();
