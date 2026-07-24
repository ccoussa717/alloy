import { readFileSync } from "node:fs";

const path = process.argv[2] || "gl-secret-detection-report.json";
let report;
try {
  report = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  console.error(`cannot read secret-detection report ${path}: ${error.message}`);
  process.exit(1);
}

if (
  !report ||
  typeof report !== "object" ||
  Array.isArray(report) ||
  typeof report.version !== "string" ||
  report.scan?.status !== "success" ||
  report.scan?.type !== "secret_detection" ||
  !Object.hasOwn(report, "vulnerabilities") ||
  !Array.isArray(report.vulnerabilities)
) {
  console.error(
    "secret-detection report is malformed or does not describe a successful secret-detection scan",
  );
  process.exit(1);
}

const validIdentity = (value) =>
  value &&
  typeof value.id === "string" && value.id.trim() &&
  typeof value.name === "string" && value.name.trim() &&
  typeof value.version === "string" && value.version.trim() &&
  typeof value.vendor?.name === "string" && value.vendor.name.trim();
const validTimestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value) &&
  !Number.isNaN(Date.parse(value));
if (
  !/^\d+\.\d+\.\d+$/.test(report.version) ||
  !validIdentity(report.scan.analyzer) ||
  !validIdentity(report.scan.scanner) ||
  !validTimestamp(report.scan.start_time) ||
  !validTimestamp(report.scan.end_time) ||
  Date.parse(report.scan.end_time) < Date.parse(report.scan.start_time)
) {
  console.error("secret-detection report is missing required GitLab scan metadata");
  process.exit(1);
}

const findings = report.vulnerabilities;
if (findings.length) {
  for (const finding of findings) {
    console.error(
      `${finding?.severity || "Unknown"}: ${finding?.name || finding?.message || "secret finding"}`,
    );
  }
  process.exit(1);
}
console.log("secret-detection report contains no findings");
