// Build the in-iframe anchor IIFE and emit it as a committed generated TS string the backend bridge
// inlines (S-005). DETERMINISTIC + flake-free: the artifact is generated here, committed, and read
// synchronously at module load — `bun test` and the running server both see the same bytes with no
// network/async build at runtime.
//
// Regenerate after editing packages/anchor/src/**:
//   bun run --filter @anchord/anchor build:iife
//
// The generated file is checked in; CI/tests do NOT rebuild it.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const entry = join(pkgRoot, "src", "iife-entry.ts");
const outFile = join(pkgRoot, "..", "..", "apps", "backend", "src", "annotation", "anchor-iife.generated.ts");

const result = await Bun.build({
  entrypoints: [entry],
  target: "browser",
  format: "iife",
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("anchor IIFE build failed");
}

const artifact = result.outputs.find((o) => o.kind === "entry-point") ?? result.outputs[0];
if (!artifact) throw new Error("anchor IIFE build produced no output");
const iife = (await artifact.text()).trim();

const header = `// GENERATED — do not edit by hand. Source: packages/anchor/src/iife-entry.ts
// Regenerate: bun run --filter @anchord/anchor build:iife
// This is the browser-IIFE compile of the shared @anchord/anchor module (S-005). The in-iframe
// sandbox bridge inlines ANCHOR_IIFE so it gains the SAME locate ladder the FE markdown path uses
// (one source, no hand-mirrored drift). It defines window.__anchordAnchor.\n`;

// Emit as a JSON-stringified literal so the artifact survives verbatim regardless of its contents.
const body = `${header}\nexport const ANCHOR_IIFE = ${JSON.stringify(iife)};\n`;

await Bun.write(outFile, body);
console.log(`wrote ${outFile} (${(iife.length / 1024).toFixed(1)} KB IIFE)`);
