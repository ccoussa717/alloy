import { resolve } from "node:path";

export function uploadPath(uploadRoot, name) {
  return resolve(uploadRoot, name);
}
