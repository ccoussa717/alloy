export async function save(path, bytes, fs) {
  await fs.writeFile(path, bytes);
}
