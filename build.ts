import twPlugin from "bun-plugin-tailwind";

const pkg = await Bun.file("./package.json").json() as { version?: string; name?: string };
const APP_VERSION = pkg.version ?? "0.0.0";

console.log(`🏗️  Building anpan-os binaries  (v${APP_VERSION})\n`);

await Bun.$`rm -rf ./binaries && mkdir -p ./binaries`;

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
console.log("   📂 Binaries: ./binaries/");
for (const { outfile } of targets) {
  console.log(`      ${outfile}`);
}
console.log("\n💡 Deploy: copy binary to target machine and run it — no other files needed.");
