const cache = new Map();

export async function put(key, value, persist) {
  await persist(key, value);
}

export function get(key) {
  return cache.get(key);
}
