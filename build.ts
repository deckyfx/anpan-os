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

// Bun cross-compiles every one of these from any host, so a Linux CI runner produces the
// macOS binaries too and no second runner is needed.
const allTargets: { target: BunCrossTarget; outfile: string }[] = [
  { target: "bun-linux-x64",    outfile: "./binaries/anpan-os-linux-x64"    },
  { target: "bun-linux-arm64",  outfile: "./binaries/anpan-os-linux-arm64"  },
  { target: "bun-darwin-arm64", outfile: "./binaries/anpan-os-darwin-arm64" },
  { target: "bun-darwin-x64",   outfile: "./binaries/anpan-os-darwin-x64"   },
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
    compile: {
      outfile,
      // An installed binary takes its settings from how it was installed, not from the folder
      // it happens to be run in. By default Bun reads .env and bunfig.toml from the current
      // directory even in a compiled executable: run from this repo, whose .env sets
      // RUNTIME_CONFIG_DIR=./configs, the installed binary pointed itself at whatever that
      // folder held. bunfig.toml can name preload scripts, so a stray one in the working
      // directory would run inside a binary started with sudo. `bun run` still reads both.
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
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
