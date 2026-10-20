import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

const schema = await Bun.file(
  new URL("../schemas/page-export.schema.json", import.meta.url),
).json();

export function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** Validate every line of a JSONL text; returns error strings (empty when valid). */
export function validateJsonl(text: string): string[] {
  const validate = createValidator();
  const errors: string[] = [];
  if (text && !text.endsWith("\n")) errors.push("missing trailing LF");
  text
    .split("\n")
    .filter((l) => l !== "")
    .forEach((l, i) => {
      let value: unknown;
      try {
        value = JSON.parse(l);
      } catch (e) {
        errors.push(`line ${i + 1}: invalid JSON (${(e as Error).message})`);
        return;
      }
      if (!validate(value)) {
        errors.push(`line ${i + 1}: ${JSON.stringify(validate.errors)}`);
      }
    });
  return errors;
}
