import twPlugin from "bun-plugin-tailwind";

const pkg = await Bun.file("./package.json").json() as { version?: string; name?: string };
const APP_VERSION = pkg.version ?? "0.0.0";

console.log(`🏗️  Two-stage build process  (v${APP_VERSION})\n`);

// ─── Stage 1: Web assets → ./dist/ ───────────────────────────────────────────

console.log("📦 Stage 1: Building web assets...\n");

await Bun.$`rm -rf ./dist ./binaries && mkdir -p ./dist ./binaries`;

const webResult = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "bun",
  minify: true,
  sourcemap: "external",
  plugins: [twPlugin],
  define: {
    "process.env.NODE_ENV":   JSON.stringify("production"),
    "process.env.RUN_MODE":   JSON.stringify("source"),
    "process.env.APP_VERSION": JSON.stringify(APP_VERSION),
  },
});

if (!webResult.success) {
  console.error("❌ Stage 1 failed:");
  for (const log of webResult.logs) console.error(`   ${log.message}`);
  process.exit(1);
}

console.log(`✅ Stage 1 completed! (${webResult.outputs.length} files → ./dist/)\n`);

// ─── Stage 2: Cross-platform binaries → ./binaries/ ─────────────────────────

console.log("📦 Stage 2: Building binaries...\n");

type BunCrossTarget =
  | "bun-linux-x64"
  | "bun-linux-arm64"
  | "bun-darwin-x64"
  | "bun-darwin-arm64"
  | "bun-windows-x64";

const targets: { target: BunCrossTarget; outfile: string }[] = [
  { target: "bun-linux-x64",   outfile: "./binaries/anpan-os-linux-x64"   },
  { target: "bun-linux-arm64", outfile: "./binaries/anpan-os-linux-arm64" },
];

const define = {
  "process.env.NODE_ENV":    JSON.stringify("production"),
  "process.env.RUN_MODE":    JSON.stringify("binary"),
  "process.env.APP_VERSION": JSON.stringify(APP_VERSION),
};

let allPassed = true;

for (const { target, outfile } of targets) {
  process.stdout.write(`   Building ${target}...`);

  const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    compile: { outfile },
    plugins: [twPlugin],
    minify: true,
    target: target as "bun",
    define,
  });

  if (!result.success) {
    console.log(" ❌");
    for (const log of result.logs) console.error(`      ${log.message}`);
    allPassed = false;
  } else {
    const size = Bun.file(outfile).size;
    console.log(` ✅  (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

if (!allPassed) {
  console.error("\n❌ One or more binary builds failed.");
  process.exit(1);
}

console.log("\n🎉 Build successful!");
console.log("   📂 Web assets: ./dist/");
console.log("   📂 Binaries:   ./binaries/");
for (const { outfile } of targets) {
  console.log(`      ${outfile}`);
}
console.log("\n💡 Deploy: copy binary + ./dist/ to target machine");
