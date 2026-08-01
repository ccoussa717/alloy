import { isAbsolute, relative, resolve, sep } from "node:path";

export function uploadPath(uploadRoot, name) {
  const target = resolve(uploadRoot, name);
  const rel = relative(uploadRoot, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("outside_upload_root");
  return target;
}
