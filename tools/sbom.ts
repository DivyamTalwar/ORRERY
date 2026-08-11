/**
 * CycloneDX 1.6 SBOM generator for the flattened Orrery release artifact.
 *
 * The packaged plugin has no runtime dependencies, so the interesting content is not a
 * dependency tree but a per-file hash inventory: a consumer can verify that every file
 * they received is the file that was built. Build toolchain is recorded separately so
 * the SBOM never implies the artifact ships those packages.
 *
 *   bun tools/sbom.ts [--out dist/orrery-<version>.cdx.json]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");
const pluginRoot = join(root, "plugins", "orrery");

type Manifest = {
  name: string;
  version: string;
  description?: string;
  license?: string;
  repository?: string;
  author?: { name?: string; url?: string };
};

const manifest = JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8")) as Manifest;
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  devDependencies?: Record<string, string>;
};

/**
 * Files the release tarball excludes, mirrored here so the SBOM matches the artifact.
 *
 * An SBOM that lists a file the consumer did not receive is worse than no SBOM: it is a
 * hash inventory they cannot reconcile. This list must stay in step with the exclusions
 * in tools/validate.ts.
 */
const isExcluded = (relativePath: string): boolean =>
  relativePath.endsWith(".test.ts") ||
  relativePath.split(sep).includes(".DS_Store") ||
  relativePath === join("scripts", "verify.sh");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink is not packageable: ${path}`);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

const files = walk(pluginRoot)
  .map((path) => relative(pluginRoot, path))
  .filter((path) => !isExcluded(path));

const hashOf = (relativePath: string, algorithm: "SHA-256" | "SHA-512") =>
  createHash(algorithm === "SHA-256" ? "sha256" : "sha512")
    .update(readFileSync(join(pluginRoot, relativePath)))
    .digest("hex");

const purl = `pkg:generic/${manifest.name}@${manifest.version}`;

const components = files.map((path) => ({
  type: "file",
  "bom-ref": `file:${path}`,
  name: path,
  hashes: [
    { alg: "SHA-256", content: hashOf(path, "SHA-256") },
    { alg: "SHA-512", content: hashOf(path, "SHA-512") },
  ],
  properties: [{ name: `${manifest.name}:bytes`, value: String(statSync(join(pluginRoot, path)).size) }],
}));

/**
 * CycloneDX consumers -- including GitHub's SBOM attestation action -- treat
 * `serialNumber` as a mandatory marker and reject a document without one.
 *
 * It is derived from the document's own content rather than randomly generated, so the
 * SBOM stays byte-reproducible from a given tree: the same input always yields the same
 * serial. Version nibble 8 marks it as a custom-derived UUID.
 */
function deriveSerialNumber(): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ name: manifest.name, version: manifest.version, components }))
    .digest("hex");
  const variant = ((parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16);
  const uuid = [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `8${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
  return `urn:uuid:${uuid}`;
}

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: deriveSerialNumber(),
  version: 1,
  metadata: {
    // Deliberately no timestamp: the SBOM must be reproducible from a given tree.
    component: {
      type: "application",
      "bom-ref": purl,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      purl,
      ...(manifest.license ? { licenses: [{ license: { id: manifest.license } }] } : {}),
      ...(manifest.author?.name ? { authors: [{ name: manifest.author.name }] } : {}),
      externalReferences: [
        ...(manifest.repository ? [{ type: "vcs", url: manifest.repository }] : []),
      ],
      properties: [
        { name: "orrery:runtime-dependencies", value: "0" },
        { name: "orrery:runtime", value: "bun" },
        { name: "orrery:packaged-file-count", value: String(files.length) },
      ],
    },
    tools: {
      components: Object.entries(packageJson.devDependencies ?? {}).map(([name, version]) => ({
        type: "library",
        name,
        version: version.replace(/^[^\d]*/, ""),
        purl: `pkg:npm/${name}@${version.replace(/^[^\d]*/, "")}`,
        description: "build-time only; not present in the released artifact",
      })),
    },
  },
  // Every packaged file, hashed. This is the verifiable inventory.
  components,
  dependencies: [{ ref: purl, dependsOn: [] }],
};

/**
 * Self-check before writing.
 *
 * A malformed SBOM does not fail loudly at generation time -- it fails much later, in the
 * release workflow, where the attestation step rejects it and no release publishes at
 * all. Asserting the required CycloneDX markers here turns that into a build failure.
 */
function assertWellFormed(document: typeof bom): void {
  const problems: string[] = [];
  if (document.bomFormat !== "CycloneDX") problems.push("bomFormat must be CycloneDX");
  if (!/^\d+\.\d+$/.test(document.specVersion)) problems.push("specVersion must be major.minor");
  if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(document.serialNumber)) {
    problems.push(`serialNumber must be a urn:uuid (got ${document.serialNumber})`);
  }
  if (!Number.isInteger(document.version) || document.version < 1) problems.push("version must be a positive integer");
  if (!document.metadata?.component?.name) problems.push("metadata.component.name is required");
  if (!Array.isArray(document.components) || document.components.length === 0) {
    problems.push("components must be a non-empty array");
  }
  for (const component of document.components) {
    if (!component.name || !component["bom-ref"]) problems.push(`component missing name/bom-ref: ${component.name}`);
    if (!component.hashes?.some((hash) => hash.alg === "SHA-256" && /^[a-f0-9]{64}$/.test(hash.content))) {
      problems.push(`component missing a valid SHA-256: ${component.name}`);
    }
  }
  if (problems.length) throw new Error(`SBOM is not well formed:\n  - ${problems.join("\n  - ")}`);
}

assertWellFormed(bom);

const outIndex = Bun.argv.indexOf("--out");
const outPath =
  outIndex >= 0 && Bun.argv[outIndex + 1]
    ? resolve(Bun.argv[outIndex + 1]!)
    : join(root, "dist", `${manifest.name}-${manifest.version}.cdx.json`);

mkdirSync(resolve(outPath, ".."), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(bom, null, 2)}\n`, { encoding: "utf8" });
console.log(`sbom: ${relative(root, outPath)} (${files.length} packaged files, 0 runtime dependencies)`);
