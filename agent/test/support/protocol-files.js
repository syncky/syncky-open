import { fileURLToPath } from "node:url";
import { loadJson as readJson, protocolDir } from "../../src/protocol-files.js";

const dir = protocolDir({ SYNCKY_PROTOCOL_DIR: fileURLToPath(new URL("../../../protocol/", import.meta.url)) });
export const loadJson = file => readJson(file, dir);
export const loadVectors = name => loadJson(`test-vectors/${name.endsWith(".json") ? name : `${name}.json`}`);
