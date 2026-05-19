const fs = require("node:fs");

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
packageJson.main = "./index.js";
packageJson.types = "./index.d.ts";

for (const entry of Object.values(packageJson.exports ?? {})) {
  if (entry && typeof entry === "object") {
    delete entry.bun;
    for (const key of ["default", "import", "types"]) {
      if (typeof entry[key] === "string") {
        entry[key] = entry[key].replace("./dist/", "./");
      }
    }
  }
}

fs.writeFileSync("dist/package.json", `${JSON.stringify(packageJson, null, 2)}\n`);