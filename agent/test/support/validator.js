import Ajv2020 from "ajv/dist/2020.js";

import { SCHEMA_ID_BASE, loadSchemas, protocolDir } from "../../src/protocol-files.js";

export async function createValidator({ dir = protocolDir(), schemas = loadSchemas(dir) } = {}) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const schema of schemas) ajv.addSchema(schema);
  return {
    ajv,
    validate(schemaFile, def, data) {
      const ref = `${SCHEMA_ID_BASE}${schemaFile}#/$defs/${def}`;
      const fn = ajv.getSchema(ref);
      if (!fn) throw new Error(`unknown schema ref: ${ref}`);
      const ok = fn(data);
      return { ok, errors: ok ? [] : fn.errors.map(formatAjvError) };
    },
  };
}

function formatAjvError(e) {
  const where = e.instancePath === "" ? "/" : e.instancePath;
  return `${where} ${e.message}${e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ""}`;
}
