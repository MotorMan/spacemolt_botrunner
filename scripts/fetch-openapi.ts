import { refreshOpenApiV2Spec } from "../src/openapi.js";

const destDir = process.argv[2] || process.cwd();
const force = process.argv.includes("--force");

refreshOpenApiV2Spec(destDir, force)
  .then(({ meta, path, saved, changed, throttled, status, etag }) => {
    const changeNote = changed ? "changed" : throttled ? "throttled — reused cached" : "unchanged (304)";
    console.log(`OpenAPI V2 spec ${meta.gameServerVersion} (api ${meta.apiVersion}) ${changeNote}`);
    console.log(`  status=${status}${etag ? ` etag=${etag}` : ""} ${saved ? "saved" : "already present"}`);
    console.log(`  -> ${path}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`Failed to fetch OpenAPI V2 spec: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
