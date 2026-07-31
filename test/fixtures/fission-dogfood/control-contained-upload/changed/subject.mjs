import { isAbsolute, relative, resolve } from "node:path";

export function uploadPath(uploadRoot, name) {
  const target = resolve(uploadRoot, name);
  const rel = relative(uploadRoot, target);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("outside_upload_root");
  return target;
}
