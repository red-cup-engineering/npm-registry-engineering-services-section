import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { checkPublication, houseSpecifier, DEFAULT_HOUSE_SCOPES } from "../src/publish-gate.mjs";
import { packTarball } from "./support/tarball.mjs";

// The gate reads a tarball and the packuments of the house packages it depends on; nothing is executed.
const NAME = "@red-cup-engineering/subject";
const dep = (name, versions, tags = {}) => ({
  name, "dist-tags": { latest: Object.keys(versions).at(-1), ...tags },
  versions: Object.fromEntries(Object.entries(versions).map(([version, exports]) => [version, { name, version, ...(exports === undefined ? {} : { exports }) }])),
});
const shelf = {
  "@red-cup-engineering/lib": dep("@red-cup-engineering/lib", {
    "1.0.0": { ".": "./index.mjs", "./old": "./old.mjs" },
    "1.1.0": { ".": "./index.mjs", "./thing": "./thing.mjs", "./features/*": "./features/*.mjs", "./package.json": "./package.json" },
    "2.0.0": { ".": "./index.mjs" },
    "3.0.0-beta.1": { ".": "./index.mjs", "./beta": "./beta.mjs" },
  }, { next: "3.0.0-beta.1" }),
  "@red-cup-engineering/bare": dep("@red-cup-engineering/bare", { "1.0.0": { ".": "./i.mjs" } }),
  "@red-cup-engineering/legacy": dep("@red-cup-engineering/legacy", { "1.0.0": undefined }),
  "@red-cup-engineering/other": dep("@red-cup-engineering/other", { "1.0.0": { ".": "./i.mjs", "./sub": "./sub.mjs" } }),
};
const publishedPackument = async (name) => shelf[name] ?? null;

async function check(files, { manifest = {}, version = "1.0.0" } = {}) {
  const bytes = packTarball({
    "package.json": { name: NAME, version, type: "module", exports: "./index.mjs", ...manifest },
    "index.mjs": "export {};\n",
    ...files,
  });
  return checkPublication({ name: NAME, version, bytes, publishedPackument });
}
const kinds = (violations) => violations.map(({ kind }) => kind);
const only = async (files, options, kind, pattern) => {
  const violations = await check(files, options);
  assert.deepEqual(kinds(violations), [kind], violations.map(({ message }) => message).join("\n"));
  assert.match(violations[0].message, pattern);
};

test("exact supplier manifests avoid history reads and share one selected identity across aliases", async () => {
  const library = "@red-cup-engineering/lib", calls = [];
  const bytes = packTarball({ "package.json": { name: NAME, version: "1.0.0", type: "module", exports: "./index.mjs",
    dependencies: { [library]: "1.1.0", alias: `npm:${library}@1.1.0` } },
    "index.mjs": `import "${library}/thing"; import "${library}/features/a";` });
  assert.deepEqual(await checkPublication({ name: NAME, version: "1.0.0", bytes,
    publishedManifest: async (name, version) => { calls.push([name, version]); return {
      ...shelf[name].versions[version], get readme() { throw Error("unrelated supplier content was read"); },
    }; }, publishedPackument: async () => { throw Error("an exact admitted supplier needs no historical packument"); },
  }), []);
  assert.deepEqual(calls, [[library, "1.1.0"]]);
});

test("selected exact suppliers preserve fallback, range/tag selection and missing-export diagnostics", async () => {
  const library = "@red-cup-engineering/lib";
  const bytes = packTarball({ "package.json": { name: NAME, version: "1.0.0", type: "module", exports: "./index.mjs",
    dependencies: { [library]: "1.0.0", range: `npm:${library}@^1.0.0`, tag: `npm:${library}@next` } },
    "index.mjs": `import "${library}/thing";` });
  const expected = await checkPublication({ name: NAME, version: "1.0.0", bytes, publishedPackument });
  for (const selected of [null, shelf[library].versions["1.0.0"]]) {
    const exact = [], histories = [];
    const actual = await checkPublication({ name: NAME, version: "1.0.0", bytes,
      publishedManifest: async (name, version) => { exact.push([name, version]); return selected; },
      publishedPackument: async name => { histories.push(name); return publishedPackument(name); },
    });
    assert.deepEqual(actual, expected);
    assert.deepEqual(exact, [[library, "1.0.0"]], "ranges and tags retain the original history resolver");
    assert.deepEqual(histories, [library], "fallback and diagnostics share the original history cache");
  }
});

test("a selected supplier with another immutable identity refuses instead of falling back", async () => {
  const library = "@red-cup-engineering/lib";
  const bytes = packTarball({ "package.json": { name: NAME, version: "1.0.0", dependencies: { [library]: "1.0.0" } } });
  for (const selected of [{ name: library, version: "1.1.0" }, { name: "@red-cup-engineering/other", version: "1.0.0" }])
    await assert.rejects(checkPublication({ name: NAME, version: "1.0.0", bytes,
      publishedManifest: async () => selected, publishedPackument: async () => { throw Error("identity refusal must not silently select another supplier"); },
    }), /selected supplier manifest differs/);
});

test("publication releases complete dependency histories before reading the next supplier while preserving version and export evidence", () => {
  const receive = async (gate, tarball) => {
    const assert = (await import("node:assert/strict")).default;
    const { checkPublication } = await import(gate);
    const { packTarball } = await import(tarball);
    const name = "@red-cup-engineering/subject";
    const library = "@red-cup-engineering/library";
    const probe = "@red-cup-engineering/probe";
    const alias = "@red-cup-engineering/library-next";
    let original, unrelated, reads = 0;
    const publishedPackument = async dependency => {
      if (dependency === library) {
        reads++;
        const document = {
          name: library, "dist-tags": { latest: "1.0.0", next: "2.0.0" },
          versions: {
            "1.0.0": { name: library, version: "1.0.0", exports: { ".": "./index.mjs" }, readme: { text: "historical payload" } },
            "2.0.0": { name: library, version: "2.0.0", exports: { ".": "./index.mjs", "./new": "./new.mjs" } },
          },
        };
        original = new WeakRef(document);
        unrelated = new WeakRef(document.versions["1.0.0"].readme);
        return document;
      }
      assert.equal(dependency, probe);
      // A separate native process makes collection explicit without changing
      // the server's GC policy or relying on timing/heap-size heuristics.
      await new Promise(resolve => setImmediate(resolve));
      global.gc();
      await new Promise(resolve => setImmediate(resolve));
      global.gc();
      assert.equal(original.deref(), undefined, "the gate must release the complete supplier packument before requesting another");
      assert.equal(unrelated.deref(), undefined, "unrelated selected-manifest payload must not remain in the gate's custody");
      return { name: probe, versions: { "1.0.0": { exports: "./index.mjs" } } };
    };
    const bytes = packTarball({
      "package.json": { name, version: "1.0.0", type: "module", exports: "./index.mjs", dependencies: {
        [library]: "^1.0.0", [probe]: "1.0.0", [alias]: `npm:${library}@next`,
      } },
      "index.mjs": `import "${library}/new"; import "${alias}/new";`,
    });
    const violations = await checkPublication({ name, version: "1.0.0", bytes, publishedPackument });
    assert.equal(reads, 1, "two declared selections share the same received version/export evidence");
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, "dependency-subpath");
    assert.match(violations[0].message, /library@1\.0\.0.*highest published version satisfying.*\^1\.0\.0/u);
    assert.match(violations[0].message, /Published versions that do export it: 2\.0\.0/u);
    process.stdout.write(JSON.stringify({ reads, violations: violations.length }));
  };
  const script = `(${receive.toString()})(${JSON.stringify(new URL("../src/publish-gate.mjs", import.meta.url).href)}, ${JSON.stringify(new URL("./support/tarball.mjs", import.meta.url).href)})`;
  const result = execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "--eval", script], { encoding: "utf8", timeout: 20_000, maxBuffer: 32_768 });
  assert.deepEqual(JSON.parse(result), { reads: 1, violations: 1 });
});

test("a package whose files, dependencies and imports agree is accepted", async () => {
  assert.deepEqual(await check({
    "src/a.mjs": 'import { x } from "@red-cup-engineering/lib";\nimport "@red-cup-engineering/lib/thing";\nexport * from "@red-cup-engineering/lib/features/deep/name";\nexport { y } from "@red-cup-engineering/other/sub";\nimport pkg from "@red-cup-engineering/lib/package.json" with { type: "json" };\nimport fs from "node:fs"; import z from "left-pad"; import w from "./b.mjs"; import "@red-cup-engineering/subject"; import "@notmine/anything/deep";\nawait import("@red-cup-engineering/lib/thing"); await import(`@red-cup-engineering/other`); await import(name);\n',
    "src/b.cjs": 'module.exports = () => import("@red-cup-engineering/bare");\n',
  }, { manifest: {
    dependencies: { "@red-cup-engineering/lib": "^1.1.0", "left-pad": "^1.0.0" }, peerDependencies: { "@red-cup-engineering/other": "1" },
    optionalDependencies: { "@red-cup-engineering/bare": "1.0.0" },
    exports: { ".": "./index.mjs", "./features/*": "./src/*.mjs" }, bin: { subject: "./src/a.mjs" },
  } }), []);
});

test("export-target: an exports target that is not in the tarball, under any condition Node resolves", async () => {
  await only({}, { manifest: { exports: "./missing.mjs" } }, "export-target", /exports\["\."\] -> \.\/missing\.mjs is not in the tarball/u);
  await only({}, { manifest: { exports: { ".": { import: "./index.mjs", default: "./gone.cjs" } } } }, "export-target", /exports\["\."\]\.default -> \.\/gone\.cjs/u);
  await only({}, { manifest: { exports: { ".": { import: "./nope.mjs", types: "./never-shipped.d.ts" } } } }, "export-target", /\.import -> \.\/nope\.mjs/u);
  await only({}, { manifest: { exports: { ".": "./index.mjs", "./x": "x.mjs" } } }, "export-target", /must start with "\.\/"/u);
  await only({}, { manifest: { exports: { ".": "./index.mjs", "./list": ["./a.mjs", "./b.mjs"] } } }, "export-target", /none of \.\/a\.mjs, \.\/b\.mjs/u);
  assert.deepEqual(await check({ "b.mjs": "" }, { manifest: { exports: { ".": "./index.mjs", "./list": ["./a.mjs", "./b.mjs"], "./types": { types: "./t.d.ts", default: "./index.mjs" } } } }), []);
});

test("export-target: a pattern target must match at least one shipped file", async () => {
  await only({}, { manifest: { exports: { ".": "./index.mjs", "./f/*": "./src/*.mjs" } } }, "export-target", /\.\/src\/\*\.mjs matches no file/u);
  assert.deepEqual(await check({ "src/a/b.mjs": "" }, { manifest: { exports: { ".": "./index.mjs", "./f/*": "./src/*.mjs" } } }), []);
});

test("bin-target: a bin that is not in the tarball, in both forms", async () => {
  await only({}, { manifest: { bin: "./cli.mjs" } }, "bin-target", /bin -> \.\/cli\.mjs is not in the tarball/u);
  await only({ "ok.mjs": "" }, { manifest: { bin: { ok: "ok.mjs", broken: "bin/broken.mjs" } } }, "bin-target", /bin\["broken"\] -> bin\/broken\.mjs/u);
});

test("undeclared-import: static, re-export and dynamic imports of a house package that is not declared", async () => {
  const violations = await check({
    "a.mjs": 'import x from "@red-cup-engineering/lib";',
    "b.mjs": 'export * from "@lenticule-science/nowhere/deep";',
    "c.mjs": 'export { y } from "@emsenn/y";',
    "d.cjs": 'const load = () => import("@561-group/z");',
    "e.mjs": 'await import(`@coesite-operations/w`);',
    "f.mjs": 'import "@causeway-services/v";',
  });
  assert.deepEqual(kinds(violations), Array(6).fill("undeclared-import"));
  assert.match(violations[0].message, /^a\.mjs:1 imports "@red-cup-engineering\/lib", but @red-cup-engineering\/lib is not in dependencies, peerDependencies or optionalDependencies$/u);
  assert.match(violations[3].message, /^d\.cjs:1 imports "@561-group\/z"/u);
});

test("undeclared-import reads syntax: comments, strings, other scopes, devDependencies and bundled node_modules do not count", async () => {
  await only({ "a.mjs": 'import x from "@red-cup-engineering/lib";' }, { manifest: { devDependencies: { "@red-cup-engineering/lib": "^1.0.0" } } }, "undeclared-import", /a\.mjs:1/u);
  assert.deepEqual(await check({
    "a.mjs": '// import x from "@red-cup-engineering/lib";\n/* import("@red-cup-engineering/lib") */\nconst s = \'import x from "@red-cup-engineering/lib"\';\nconst t = `${s} @red-cup-engineering/lib`;\nawait import(`@red-cup-engineering/${s}`);\n',
    "node_modules/bundled/index.mjs": 'import "@red-cup-engineering/lib";',
    "vendor/node_modules/x.js": 'import "@red-cup-engineering/lib";',
    "notes.txt": 'import "@red-cup-engineering/lib"',
  }), []);
});

test("undeclared-import finds an import in a .js file whether its package is CommonJS or ESM", async () => {
  await only({ "a.js": 'import x from "@red-cup-engineering/lib";' }, { manifest: { type: "module" } }, "undeclared-import", /a\.js:1/u);
  await only({ "a.js": 'import x from "@red-cup-engineering/lib";' }, { manifest: { type: "commonjs" } }, "undeclared-import", /a\.js:1/u);
  await only({ "a.js": 'const { x } = require("left-pad"); module.exports = () => import("@red-cup-engineering/lib");' }, { manifest: { type: "commonjs" } }, "undeclared-import", /a\.js:1/u);
});

const receivingManifest = {
  receivingTests: ["test/receive.test.mjs"],
  devDependencies: { "@red-cup-engineering/lib": "1.1.0" },
};
const receivingFiles = {
  "test/receive.test.mjs": 'import "./support/consumer.mjs";',
  "test/support/consumer.mjs": 'import "@red-cup-engineering/lib/thing";',
};

test("explicit receiving roots and their private local helpers use the declared development supplier", async () => {
  assert.deepEqual(await check(receivingFiles, { manifest: receivingManifest }), []);
  assert.deepEqual(await check({
    ...receivingFiles,
    "test/receive.test.mjs": 'await import(`./support/consumer.mjs`);',
  }, { manifest: receivingManifest }), []);
  await only({ ...receivingFiles, "unrelated.mjs": 'import "@red-cup-engineering/lib/thing";' },
    { manifest: receivingManifest }, "undeclared-import", /unrelated\.mjs/u);
});

test("receiving declarations cannot relabel a helper reached by the public runtime", async () => {
  for (const source of [
    'import "./test/support/consumer.mjs";',
    'export * from "./test/support/consumer.mjs";',
    'await import("./test/support/consumer.mjs?runtime");',
    'const require = createRequire(import.meta.url); require(`./test/support/consumer.mjs`);',
  ]) await only({ ...receivingFiles, "index.mjs": source }, { manifest: receivingManifest },
    "undeclared-import", /test\/support\/consumer\.mjs/u);
  for (const extra of [
    { exports: { ".": "./index.mjs", "./receiving/*": "./test/support/*.mjs" } },
    { bin: { receive: "./test/support/consumer.mjs" } },
    { main: "./test/support/consumer.mjs" },
    { exports: undefined },
    { scripts: { postinstall: "node test/support/consumer.mjs" } },
  ]) await only(receivingFiles, { manifest: { ...receivingManifest, ...extra } },
    "undeclared-import", /test\/support\/consumer\.mjs/u);
});

test("public self references and package imports retain their runtime closure", async () => {
  await only({ ...receivingFiles, "index.mjs": 'import "#private";' }, { manifest: {
    ...receivingManifest, imports: { "#private": { import: "./test/support/consumer.mjs" } },
  } }, "undeclared-import", /test\/support\/consumer\.mjs/u);
  await only({ ...receivingFiles, "index.mjs": 'import "@red-cup-engineering/subject/private";',
    "bridge.mjs": 'import "./test/support/consumer.mjs";',
  }, { manifest: { ...receivingManifest, exports: { ".": "./index.mjs", "./private": "./bridge.mjs" } } },
  "undeclared-import", /test\/support\/consumer\.mjs/u);
});

test("receiving development suppliers retain publication, range and export checks", async () => {
  await only(receivingFiles, { manifest: { ...receivingManifest,
    devDependencies: { "@red-cup-engineering/lib": "9.9.9" } } }, "dependency", /devDependencies.*no published version/u);
  await only(receivingFiles, { manifest: { ...receivingManifest,
    devDependencies: { "@red-cup-engineering/lib": "1.0.0" } } }, "dependency-subpath", /does not export "\.\/thing"/u);
  await only(receivingFiles, { manifest: { receivingTests: receivingManifest.receivingTests } },
    "undeclared-import", /not in dependencies/u);
  await only({ "test/receive.test.mjs": 'import "@red-cup-engineering/ghost";' }, { manifest: {
    receivingTests: receivingManifest.receivingTests, devDependencies: { "@red-cup-engineering/ghost": "1.0.0" },
  } }, "dependency", /devDependencies.*not published/u);
});

test("a missing receiving root cannot confer a development context", async () => {
  await only({}, { manifest: receivingManifest }, "receiving-test", /test\/receive\.test\.mjs.*not a file/u);
  await only({}, { manifest: { receivingTests: "test/receive.test.mjs" } }, "receiving-test", /must name original files/u);
  await only(receivingFiles, { manifest: { ...receivingManifest,
    devDependencies: { "@red-cup-engineering/lib": "1.1.0", "@red-cup-engineering/unused": "9.0.0" },
    dependencies: { "@red-cup-engineering/lib": "1.0.0" },
  } }, "dependency-subpath", /highest published version satisfying "1.0.0"/u);
});

test("dependency: a declared house dependency with no published package, version or tag is refused", async () => {
  await only({}, { manifest: { dependencies: { "@red-cup-engineering/ghost": "^1.0.0" } } }, "dependency", /dependencies\["@red-cup-engineering\/ghost"\]: "\^1\.0\.0": @red-cup-engineering\/ghost is not published in this registry/u);
  await only({}, { manifest: { dependencies: { "@red-cup-engineering/lib": "^1.2.0" } } }, "dependency", /no published version satisfies "\^1\.2\.0" \(newest published: 3\.0\.0-beta\.1, 2\.0\.0, 1\.1\.0, 1\.0\.0\)/u);
  await only({}, { manifest: { peerDependencies: { "@red-cup-engineering/lib": "9.9.9" } } }, "dependency", /peerDependencies\["@red-cup-engineering\/lib"\]: "9\.9\.9"/u);
  await only({}, { manifest: { optionalDependencies: { "@red-cup-engineering/lib": "nightly" } } }, "dependency", /neither a semver range nor a dist-tag/u);
  await only({}, { manifest: { dependencies: { "@red-cup-engineering/lib": "workspace:*" } } }, "dependency", /workspace:\*/u);
  await only({}, { manifest: { dependencies: { "@red-cup-engineering/lib": "file:../lib" } } }, "dependency", /file:\.\.\/lib/u);
  await only({}, { manifest: { dependencies: { alias: "npm:@red-cup-engineering/ghost@1" } } }, "dependency", /@red-cup-engineering\/ghost is not published/u);
  assert.deepEqual(await check({}, { manifest: { dependencies: { "@red-cup-engineering/lib": "next", "@red-cup-engineering/bare": "*", "@red-cup-engineering/other": ">=1 <2", alias: "npm:@red-cup-engineering/lib@1" } } }), []);
});

test("dependency-subpath: an import the highest published version satisfying the range does not export", async () => {
  await only({ "a.mjs": 'import "@red-cup-engineering/lib/thing";' }, { manifest: { dependencies: { "@red-cup-engineering/lib": "~1.0.0" } } }, "dependency-subpath",
    /^a\.mjs:1 imports "@red-cup-engineering\/lib\/thing", but @red-cup-engineering\/lib@1\.0\.0 \(the highest published version satisfying "~1\.0\.0"\) does not export "\.\/thing"; it exports \., \.\/old\. Published versions that do export it: 1\.1\.0$/u);
  // the highest satisfying version is the one judged, not the lowest or the latest tag
  await only({ "a.mjs": 'import "@red-cup-engineering/lib/thing";' }, { manifest: { dependencies: { "@red-cup-engineering/lib": "^1.0.0 || ^2.0.0" } } }, "dependency-subpath", /@red-cup-engineering\/lib@2\.0\.0 \(the highest/u);
  assert.deepEqual(await check({ "a.mjs": 'import "@red-cup-engineering/lib/thing";' }, { manifest: { dependencies: { "@red-cup-engineering/lib": "^1.0.0" } } }), []);
  await only({ "a.mjs": 'import "@red-cup-engineering/lib/beta";' }, { manifest: { dependencies: { "@red-cup-engineering/lib": "^1.0.0" } } }, "dependency-subpath", /does not export "\.\/beta"/u);
  assert.deepEqual(await check({ "a.mjs": 'import "@red-cup-engineering/lib/beta";' }, { manifest: { dependencies: { "@red-cup-engineering/lib": "next" } } }), []);
});

test("dependency-subpath: pattern exports, ./package.json and the package root are all judged by the manifest", async () => {
  const dependencies = { "@red-cup-engineering/lib": "1.1.0", "@red-cup-engineering/bare": "1.0.0" };
  assert.deepEqual(await check({ "a.mjs": 'import "@red-cup-engineering/lib/features/a"; import "@red-cup-engineering/lib/features/a/b"; import "@red-cup-engineering/lib/package.json";' }, { manifest: { dependencies } }), []);
  await only({ "a.mjs": 'import "@red-cup-engineering/lib/featurez/a";' }, { manifest: { dependencies } }, "dependency-subpath", /does not export "\.\/featurez\/a"/u);
  await only({ "a.mjs": 'import "@red-cup-engineering/bare/package.json";' }, { manifest: { dependencies } }, "dependency-subpath", /@red-cup-engineering\/bare@1\.0\.0 .* does not export "\.\/package\.json"; it exports \.$/u);
  await only({ "a.mjs": 'import "@red-cup-engineering/bare/";' }, { manifest: { dependencies } }, "dependency-subpath", /does not export "\.\/"/u);
  await only({ "a.mjs": 'import "@red-cup-engineering/lib/old";' }, { manifest: { dependencies: { "@red-cup-engineering/lib": "1.1.0" } } }, "dependency-subpath", /does not export "\.\/old"/u);
});

test("dependency-subpath: a dependency that declares no exports exposes its files and is not second-guessed", async () => {
  assert.deepEqual(await check({ "a.mjs": 'import "@red-cup-engineering/legacy"; import "@red-cup-engineering/legacy/lib/x.js";' }, { manifest: { dependencies: { "@red-cup-engineering/legacy": "1" } } }), []);
});

test("self-import: the package named by its own exports, or not at all", async () => {
  await only({ "a.mjs": 'import "@red-cup-engineering/subject/nope";' }, {}, "self-import", /a\.mjs:1 imports "@red-cup-engineering\/subject\/nope", but @red-cup-engineering\/subject does not export "\.\/nope" \(its exports: \.\)/u);
  await only({ "a.mjs": 'import "@red-cup-engineering/subject/y/missing";', "src/y/z.mjs": "" }, { manifest: { exports: { ".": "./index.mjs", "./y/*": "./src/y/*.mjs" } } }, "self-import", /exports as \.\/src\/y\/missing\.mjs, but that file is not in the tarball/u);
  await only({ "a.mjs": 'import "@red-cup-engineering/subject/x";' }, { manifest: { exports: { ".": "./index.mjs", "./x": "./x.mjs" } } }, "export-target", /\.\/x\.mjs is not in the tarball/u);
  await only({ "a.mjs": 'import "@red-cup-engineering/subject";' }, { manifest: { exports: undefined, main: "index.mjs" } }, "self-import", /declares no "exports"/u);
  assert.deepEqual(await check({ "a.mjs": 'import "@red-cup-engineering/subject/y/z";', "src/y/z.mjs": "" }, { manifest: { exports: { ".": "./index.mjs", "./y/*": "./src/y/*.mjs" } } }), []);
});

test("source: a module that names a house package but cannot be read is refused, not skipped", async () => {
  await only({ "a.mjs": 'import x from "@red-cup-engineering/lib"; const = ;' }, {}, "source", /a\.mjs names a house package but cannot be read as JavaScript: .*\(1:/u);
  assert.deepEqual(await check({ "broken.mjs": "const = ;", "notes.js": "{{{" }), [], "a file that names no house package is not this gate's business");
});

test("tarball: bytes that are not a package, or are another package, are refused", async () => {
  const bad = async (bytes, pattern) => {
    const violations = await checkPublication({ name: NAME, version: "1.0.0", bytes, publishedPackument });
    assert.deepEqual(kinds(violations), ["tarball"]);
    assert.match(violations[0].message, pattern);
  };
  await bad(Buffer.from("fixture artifact"), /not gzip/u);
  await bad(packTarball({ "index.mjs": "" }), /no readable package\.json/u);
  await bad(packTarball({ "package.json": "{" }), /no readable package\.json/u);
  await bad(packTarball({ "package.json": { name: "@red-cup-engineering/other", version: "1.0.0" } }), /is @red-cup-engineering\/other@1\.0\.0, not the @red-cup-engineering\/subject@1\.0\.0 being published/u);
  await bad(packTarball({ "package.json": { name: NAME, version: "1.0.1" } }), /@red-cup-engineering\/subject@1\.0\.1, not/u);
});

test("every violation is reported at once", async () => {
  const violations = await check({ "a.mjs": 'import "@red-cup-engineering/lib/thing"; import "@red-cup-engineering/other";' }, {
    manifest: { exports: { ".": "./index.mjs", "./gone": "./gone.mjs" }, bin: { c: "./c.mjs" }, dependencies: { "@red-cup-engineering/lib": "~1.0.0", "@red-cup-engineering/ghost": "1" } },
  });
  assert.deepEqual(kinds(violations).sort(), ["bin-target", "dependency", "dependency-subpath", "export-target", "undeclared-import"]);
});

test("house specifiers are recognised by scope and split into package and subpath", () => {
  assert.deepEqual(houseSpecifier("@red-cup-engineering/a", DEFAULT_HOUSE_SCOPES), { name: "@red-cup-engineering/a", subpath: "." });
  assert.deepEqual(houseSpecifier("@emsenn/a/b/c.mjs", DEFAULT_HOUSE_SCOPES), { name: "@emsenn/a", subpath: "./b/c.mjs" });
  for (const other of ["left-pad", "@types/node", "node:fs", "./x", "@red-cup-engineering", "@red-cup-engineeringx/a"]) assert.equal(houseSpecifier(other, DEFAULT_HOUSE_SCOPES), null, other);
});

test("native non-JavaScript exports preserve explicit receiving context without granting runtime dev imports",async()=>{
  const manifest={...receivingManifest,exports:{".":"./index.mjs","./constructor.scm":"./native-code-programme.scm"}};
  const files={...receivingFiles,"native-code-programme.scm":"(define-module (native-code-programme))\n"};
  assert.deepEqual(await check(files,{manifest}),[]);
  await only({...files,"index.mjs":'import "./test/support/consumer.mjs";'},{manifest},
    "undeclared-import",/test\/support\/consumer\.mjs/u);
  await only(files,{manifest:{...manifest,receivingTests:undefined}},
    "undeclared-import",/test\/support\/consumer\.mjs/u);
  const unread=await check({...files,"index.mjs":'import "@red-cup-engineering/lib"; invalid syntax {{{'},{manifest});
  assert.deepEqual(kinds(unread),["source","undeclared-import"]);
  assert.match(unread[0].message,/cannot be read as JavaScript/u);
  await only({...files,"native-cli":'#!/usr/bin/env node\nimport "./test/support/consumer.mjs";'},
    {manifest:{...manifest,bin:{native:"./native-cli"}}},"undeclared-import",/test\/support\/consumer\.mjs/u);
});
