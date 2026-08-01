const cache = new Map();

export async function put(key, value, persist) {
  await persist(key, value);
  cache.delete(key);
}
