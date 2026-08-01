import twPlugin from "bun-plugin-tailwind";

const pkg = await Bun.file("./package.json").json() as { version?: string; name?: string };
const APP_VERSION = pkg.version ?? "0.0.0";

console.log(`🏗️  Building anpan-os binaries  (v${APP_VERSION})\n`);

await Bun.$`mkdir -p ./binaries`;

type BunCrossTarget =
  | "bun-linux-x64"
  | "bun-linux-arm64"
  | "bun-darwin-x64"
  | "bun-darwin-arm64"
  | "bun-windows-x64";

const allTargets: { target: BunCrossTarget; outfile: string }[] = [
  { target: "bun-linux-x64",   outfile: "./binaries/anpan-os-linux-x64"   },
  { target: "bun-linux-arm64", outfile: "./binaries/anpan-os-linux-arm64" },
];

// Optional filter: BUILD_TARGETS="bun-linux-x64" (comma-separated) builds a subset.
// Used by install-local.sh to build only the host architecture.
const filter = Bun.env.BUILD_TARGETS?.split(",").map((t) => t.trim()).filter(Boolean);
const targets = filter?.length
  ? allTargets.filter((t) => filter.includes(t.target))
  : allTargets;

if (targets.length === 0) {
  console.error(`❌ BUILD_TARGETS matched no known target. Known: ${allTargets.map((t) => t.target).join(", ")}`);
  process.exit(1);
}

const define = {
  "process.env.NODE_ENV":    JSON.stringify("production"),
  "process.env.RUN_MODE":    JSON.stringify("binary"),
  "process.env.APP_VERSION": JSON.stringify(APP_VERSION),
};

// Remove only the artifacts we are about to rebuild, so a filtered build
// does not delete a previously built binary for another architecture.
for (const { outfile } of targets) await Bun.$`rm -f ${outfile}`;

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
console.log("   📂 Binaries: ./binaries/");
for (const { outfile } of targets) {
  console.log(`      ${outfile}`);
}
console.log("\n💡 Deploy: copy binary to target machine and run it — no other files needed.");
