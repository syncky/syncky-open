import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

fs.fsyncSync = fs.fdatasyncSync = fd => { fs.fstatSync(fd); };
fs.fsync = fs.fdatasync = (fd, callback) => {
  fs.fstat(fd, error => callback(error));
};

const handle = await fs.promises.open(new URL(import.meta.url), "r");
const prototype = Object.getPrototypeOf(handle);
await handle.close();
prototype.sync = prototype.datasync = async function () { await this.stat(); };

syncBuiltinESMExports();
